import { FastifyPluginAsync } from 'fastify';
import { authenticate } from '../middleware/auth';
import { getRedis } from '../utils/redis';

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  'Connection': 'keep-alive',
  'X-Accel-Buffering': 'no',
};

function setSSEHeaders(reply: any) {
  for (const [key, value] of Object.entries(SSE_HEADERS)) {
    reply.header(key, value);
  }
}

export const wsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    '/sse',
    { preHandler: [authenticate] },
    async (req, reply) => {
      reply.type('text/event-stream');
      setSSEHeaders(reply);

      const userId = (req.user as { id: string }).id;
      const redis = getRedis();

      if (!redis) {
        reply.raw.write(`data: ${JSON.stringify({ type: 'error', message: 'Redis not available' })}\n\n`);
        reply.raw.end();
        return reply;
      }

      const channel = `user:${userId}:sse`;
      const subscriber = redis.duplicate();
      await subscriber.subscribe(channel);

      const send = (data: unknown) => {
        if (req.raw.destroyed) return;
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
      }, 30000);

      req.raw.on('close', async () => {
        clearInterval(heartbeat);
        await subscriber.quit();
        reply.raw.end();
      });

      return reply;
    },
  );

  fastify.get(
    '/sse/token',
    async (req, reply) => {
      const token = (req.query as Record<string, string>).token;
      if (!token) {
        return reply.status(401).send({ error: 'Missing token' });
      }

      try {
        const decoded = await reply.server.jwt.verify<{ id: string }>(token);
        const userId = decoded.id;
        const redis = getRedis();

        if (!redis) {
          return reply.status(503).send({ error: 'Redis not available' });
        }

        reply.type('text/event-stream');
        setSSEHeaders(reply);

        const channel = `user:${userId}:sse`;
        const subscriber = redis.duplicate();
        await subscriber.subscribe(channel);

        const send = (data: unknown) => {
          if (req.raw.destroyed) return;
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
        }, 30000);

        req.raw.on('close', async () => {
          clearInterval(heartbeat);
          await subscriber.quit();
          reply.raw.end();
        });

        return reply;
      } catch {
        return reply.status(401).send({ error: 'Invalid token' });
      }
    },
  );

  fastify.get(
    '/live/stats',
    { preHandler: [authenticate] },
    async (req, reply) => {
      reply.type('text/event-stream');
      setSSEHeaders(reply);

      const redis = getRedis();

      const send = (data: unknown) => {
        if (req.raw.destroyed) return;
        reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      if (redis) {
        const stats = await redis.hgetall('stats:live');
        send({ type: 'stats', data: stats });
      } else {
        send({ type: 'stats', data: {} });
      }

      const interval = setInterval(async () => {
        if (redis) {
          const updated = await redis.hgetall('stats:live');
          send({ type: 'stats_update', data: updated });
        }
      }, 5000);

      req.raw.on('close', () => {
        clearInterval(interval);
        reply.raw.end();
      });

      return reply;
    },
  );
};
