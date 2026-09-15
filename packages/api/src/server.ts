import Fastify from 'fastify';
import Cors from '@fastify/cors';
import Helmet from '@fastify/helmet';
import Compress from '@fastify/compress';
import Websocket from '@fastify/websocket';
import RateLimit from '@fastify/rate-limit';
import Jwt from '@fastify/jwt';
import { errorHandler } from './middleware/error-handler';
import routes from './routes';
import { env } from './utils/env';
import { requestLogger, getPrometheusMetrics } from './utils/logging';

const server = async () => {
  const app = Fastify({
    // trustProxy must match the actual trusted proxy hop count; off by default so
    // req.ip can't be spoofed via X-Forwarded-For (keeps rate-limiting honest).
    // Set TRUST_PROXY=true only when running behind a trusted reverse proxy.
    // (fastify 5 dropped the numeric-hop form; boolean trusts the leftmost
    // X-Forwarded-For entry, which is the single-proxy case this gate covers.)
    trustProxy: process.env.TRUST_PROXY === 'true',
    logger: env.NODE_ENV === 'development'
      ? { level: 'info' }
      : { level: 'warn', redact: ['req.headers.authorization'] },
  });

  // `origin: '*'` alongside credentials:true is the classic CORS mistake: browsers
  // reject it outright, and any deployment that loosened the response would let an
  // attacker's page read authenticated responses. With no explicit origin configured
  // we send no CORS headers at all, which is correct for the same-origin docker setup.
  await app.register(Cors, {
    origin: env.CORS_ORIGIN ? env.CORS_ORIGIN.split(',').map((o) => o.trim()) : false,
    credentials: true,
  });
  await app.register(Helmet);
  await app.register(Compress);
  await app.register(RateLimit, {
    max: 100,
    timeWindow: '1 minute',
  });
  await app.register(Jwt, {
    secret: {
      public: process.env.JWT_PUBLIC_KEY || env.JWT_SECRET,
      private: process.env.JWT_PRIVATE_KEY || env.JWT_SECRET,
    },
    sign: {
      expiresIn: env.JWT_EXPIRES_IN || '7d',
    },
  });
  await app.register(Websocket);

  app.addHook('preHandler', requestLogger);
  app.addHook('preHandler', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
  });
  app.setErrorHandler(errorHandler);

  app.get('/metrics', async (_req, reply) => {
    reply.header('Content-Type', 'text/plain; version=0.0.4');
    return getPrometheusMetrics();
  });

  app.get('/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.floor(process.uptime()),
  }));

  await app.register(routes, { prefix: '/api' });

  return app;
};

export default server;
