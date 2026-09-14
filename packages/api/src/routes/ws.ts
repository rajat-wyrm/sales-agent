import { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import IORedis from 'ioredis';
import { authenticate } from '../middleware/auth';
import { getRedis } from '../utils/redis';

function setSSEHeaders(reply: FastifyReply) {
  // Raw headers on the hijacked response: Fastify must NOT manage this reply
  // (reply.raw.write without hijack produces a 200 with no content-type, which
  // browsers reject as "not text/event-stream"). Call reply.hijack() first.
  reply.raw.setHeader('Content-Type', 'text/event-stream');
  reply.raw.setHeader('Cache-Control', 'no-cache');
  reply.raw.setHeader('Connection', 'keep-alive');
  reply.raw.setHeader('X-Accel-Buffering', 'no'); // nginx/Caddy must not buffer
}

/**
 * Open one SSE stream for `userId`, fanning in both their personal channel
 * (direct actions) and the broadcast channel (army / scheduler completions,
 * published under sentinel requesters no browser subscribes to). Without
 * broadcast, background wave completions never reach any UI.
 *
 * Shared by /sse (header/JWT-authenticated) and /sse/token (query-param token,
 * because EventSource cannot set an Authorization header). Previously these were
 * two near-identical 50-line copies; the query-param copy had no revocation
 * check, so a logged-out or revoked token kept streaming lead data.
 */
async function openUserStream(
  req: FastifyRequest,
  reply: FastifyReply,
  userId: string,
): Promise<FastifyReply> {
  reply.hijack();
  setSSEHeaders(reply);

  const redis = getRedis();
  if (!redis) {
    reply.raw.write(`data: ${JSON.stringify({ type: 'error', message: 'Redis not available' })}\n\n`);
    reply.raw.end();
    return reply;
  }

  // Dedicated connection: sharing the app's command client would serialize
  // pub/sub against request traffic and leak subscriptions on close.
  const subscriber: IORedis = redis.duplicate();
  await subscriber.subscribe(`user:${userId}:sse`, 'broadcast:sse');

  const send = (data: unknown) => {
    if (req.raw.destroyed || reply.raw.writableEnded) return;
    reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  subscriber.on('message', (_channel: string, message: string) => {
    try {
      send(JSON.parse(message));
    } catch {
      send({ raw: message });
    }
  });

  send({ type: 'connected', user_id: userId });

  const heartbeat = setInterval(() => {
    send({ type: 'heartbeat', timestamp: Date.now() });
  }, 30_000);

  // Close is the only reliable end signal; also guard against a subscriber whose
  // client vanished mid-write so we never leave an interval + connection behind.
  const cleanup = () => {
    clearInterval(heartbeat);
    subscriber.removeAllListeners('message');
    void subscriber.quit().catch(() => subscriber.disconnect());
    if (!reply.raw.writableEnded) reply.raw.end();
  };
  req.raw.on('close', cleanup);
  req.raw.on('error', cleanup);

  return reply;
}

export const wsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    '/sse',
    { preHandler: [authenticate] },
    async (req, reply) => openUserStream(req, reply, (req.user as { id: string }).id),
  );

  fastify.get('/sse/token', async (req, reply) => {
    const token = (req.query as Record<string, string>).token;
    if (!token) {
      return reply.status(401).send({ error: 'Missing token' });
    }

    let userId: string;
    try {
      userId = (await reply.server.jwt.verify<{ id: string }>(token)).id;
    } catch {
      return reply.status(401).send({ error: 'Invalid token' });
    }

    // Revocation must apply here too: logout blacklists the token, but EventSource
    // authenticates via query param and skipped that check, so a stream stayed open
    // (and could be re-opened) after logout.
    const redis = getRedis();
    if (redis) {
      const blacklisted = await redis.get(`bl_:${token}`);
      if (blacklisted) {
        return reply.status(401).send({ error: 'Token has been revoked' });
      }
    }

    // The subject must still exist: tokens live 7d and survive account deletion or
    // a DB re-seed, and opening a stream for a ghost id leaks nothing useful while
    // holding a Redis connection forever.
    const { getDB } = await import('../utils/db');
    const existing = await getDB().unsafe(`SELECT 1 FROM users WHERE id = $1`, [userId]);
    if ((existing as unknown[]).length === 0) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    return openUserStream(req, reply, userId);
  });

  fastify.get(
    '/live/stats',
    { preHandler: [authenticate] },
    async (req, reply) => {
      reply.hijack();
      setSSEHeaders(reply);

      const redis = getRedis();

      const send = (data: unknown) => {
        if (req.raw.destroyed || reply.raw.writableEnded) return;
        reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      if (redis) {
        const stats = await redis.hgetall('stats:live');
        send({ type: 'stats', data: stats });
      } else {
        send({ type: 'stats', data: {} });
      }

      const interval = setInterval(async () => {
        if (!redis) return;
        try {
          const updated = await redis.hgetall('stats:live');
          send({ type: 'stats_update', data: updated });
        } catch {
          // A dropped Redis connection degrades to no updates rather than killing
          // the request loop with an unhandled rejection.
        }
      }, 5000);

      req.raw.on('close', () => {
        clearInterval(interval);
        if (!reply.raw.writableEnded) reply.raw.end();
      });

      return reply;
    },
  );
};
