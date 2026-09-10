import { FastifyRequest, FastifyReply } from 'fastify';
import { getRedis } from '../utils/redis';

interface JWTPayload {
  id: string;
  email: string;
  role: string;
}

export async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const token = (request.headers.authorization || '').replace('Bearer ', '');
    const redis = getRedis();
    if (redis) {
      const blacklisted = await redis.get(`bl_:${token}`);
      if (blacklisted) {
        reply.status(401).send({ error: 'Token has been revoked' });
        return;
      }
    }
    await request.jwtVerify();
  } catch {
    reply.status(401).send({ error: 'Unauthorized' });
  }
}

export function authorize(allowedRoles: string[]) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    try {
      const token = (request.headers.authorization || '').replace('Bearer ', '');
      const redis = getRedis();
      if (redis) {
        const blacklisted = await redis.get(`bl_:${token}`);
        if (blacklisted) {
          reply.status(401).send({ error: 'Token has been revoked' });
          return;
        }
      }
      await request.jwtVerify();
      const user = request.user as unknown as JWTPayload;
      if (user && !allowedRoles.includes(user.role)) {
        reply.status(403).send({ error: 'Forbidden: insufficient permissions' });
        return;
      }
    } catch {
      reply.status(401).send({ error: 'Unauthorized' });
    }
  };
}
