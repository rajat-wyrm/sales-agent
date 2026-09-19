import { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import IORedis from 'ioredis';
import { streamToken } from './auth';
import { getDB } from '../utils/db';
import { getRedis } from '../utils/redis';
import { OPS_CHANNEL, SHARED_CHANNEL } from '../utils/sse';

function setSSEHeaders(reply: FastifyReply) {
  // Raw headers on the hijacked response: Fastify must NOT manage this reply
  // (reply.raw.write without hijack produces a 200 with no content-type, which
  // browsers reject as "not text/event-stream"). Call reply.hijack() first.
  reply.raw.setHeader('Content-Type', 'text/event-stream');
  reply.raw.setHeader('Cache-Control', 'no-cache');
  reply.raw.setHeader('Connection', 'keep-alive');
  reply.raw.setHeader('X-Accel-Buffering', 'no'); // nginx/Caddy must not buffer
}

type StreamUser = { id: string; role: string };

/**
 * Resolve the streaming subject from the access token, which arrives either as
 * `Authorization: Bearer` (non-browser clients) or in the HttpOnly `sse_auth`
 * cookie.
 *
 * The cookie exists because `EventSource` cannot set request headers, and the
 * old workaround -- `GET /sse/token?token=<jwt>` -- put a full 7-day access token
 * into the URL, where it landed in nginx access logs, browser history, and any
 * Referer header. A cookie keeps the credential out of all of those.
 */
async function resolveStreamUser(token: string): Promise<StreamUser | null> {
  if (!token) return null;

  const redis = getRedis();
  if (redis) {
    const blacklisted = await redis.get(`bl_:${token}`);
    if (blacklisted) return null;
  }

  let userId: string;
  try {
    userId = (await getJwtVerify()(token)).id;
  } catch {
    return null;
  }
  if (!userId) return null;

  // The subject must still exist: tokens live 7d and survive account deletion or
  // a DB re-seed, and opening a stream for a ghost id leaks nothing useful while
  // holding a Redis connection forever. The role decides whether the caller may
  // subscribe to the admin-only ops channel.
  const rows = await getDB().unsafe(`SELECT id, role FROM users WHERE id = $1`, [userId]);
  const row = (rows as unknown as Array<{ id: string; role: string }>)[0];
  return row ? { id: row.id, role: row.role } : null;
}

// The JWT verifier is only reachable through the Fastify instance, which the
// route handler owns; this indirection keeps resolveStreamUser free of Fastify
// plumbing while staying a single implementation.
let jwtVerifyImpl: (<T>(token: string) => Promise<T>) | null = null;
function getJwtVerify() {
  if (!jwtVerifyImpl) throw new Error('SSE JWT verifier not initialised');
  return jwtVerifyImpl as (token: string) => Promise<{ id: string }>;
}

/**
 * Open one SSE stream for `user`, fanning in the channels that user is entitled
 * to:
 *   user:{id}:sse - their own events and events for leads they own
 *   shared:sse    - unassigned leads, which every authenticated user may read
 *   ops:sse       - deployment operations, admins only
 *
 * Each channel maps exactly onto an existing REST permission, so the stream
 * cannot disclose more than the caller could already fetch. The previous
 * implementation subscribed everyone to a single broadcast channel carrying every
 * event for every user's leads.
 */
async function openUserStream(
  req: FastifyRequest,
  reply: FastifyReply,
  user: StreamUser,
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
  const channels = [`user:${user.id}:sse`, SHARED_CHANNEL];
  if (user.role === 'admin') channels.push(OPS_CHANNEL);
  await subscriber.subscribe(...channels);

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

  send({ type: 'connected', user_id: user.id });

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
  jwtVerifyImpl = (token: string) => fastify.jwt.verify(token);

  fastify.get('/sse', async (req, reply) => {
    const user = await resolveStreamUser(streamToken(req));
    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
    return openUserStream(req, reply, user);
  });
};
