import { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getDB } from '../utils/db';
import { getRedis } from '../utils/redis';
import { hashPassword, comparePassword } from '../utils/crypto';
import { authenticate } from '../middleware/auth';
import { env } from '../utils/env';
import { clearCookie, readCookie, serializeCookie } from '../utils/cookies';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

const ACCESS_TTL_SECONDS = 7 * 24 * 60 * 60;
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;

// Cookie names + scopes. Both are HttpOnly, so no script can read them:
//   refresh_token -> Path=/api/auth   (only the refresh/logout endpoints see it)
//   sse_auth      -> Path=/api/sse    (EventSource cannot set an Authorization
//                                      header, so the stream authenticates by
//                                      cookie instead of a token in the URL)
// SameSite=Strict means a cross-site request never carries them, which is the
// CSRF story for these two endpoints. Secure is opt-in via COOKIE_SECURE because
// the shipped compose topology serves plain HTTP.
const REFRESH_COOKIE = 'refresh_token';
const REFRESH_COOKIE_PATH = '/api/auth';
const SSE_COOKIE = 'sse_auth';
const SSE_COOKIE_PATH = '/api/sse';

function sessionCookies(accessToken: string, refreshToken: string): string[] {
  const base = { httpOnly: true, sameSite: 'Strict' as const, secure: env.COOKIE_SECURE };
  return [
    serializeCookie(REFRESH_COOKIE, refreshToken, {
      ...base,
      path: REFRESH_COOKIE_PATH,
      maxAge: REFRESH_TTL_SECONDS,
    }),
    serializeCookie(SSE_COOKIE, accessToken, {
      ...base,
      path: SSE_COOKIE_PATH,
      maxAge: ACCESS_TTL_SECONDS,
    }),
  ];
}

function clearSessionCookies(): string[] {
  const base = { httpOnly: true, sameSite: 'Strict' as const, secure: env.COOKIE_SECURE };
  return [
    clearCookie(REFRESH_COOKIE, { ...base, path: REFRESH_COOKIE_PATH }),
    clearCookie(SSE_COOKIE, { ...base, path: SSE_COOKIE_PATH }),
  ];
}

/**
 * Blacklist a token for exactly as long as it can still be replayed.
 *
 * The previous code used a flat 7 days for BOTH the access token and the refresh
 * token. Access tokens live 7d so that was correct, but refresh tokens live 30d:
 * a refresh token was only refused for the first 7 of its remaining 30 days, so
 * a logged-out (or stolen-then-revoked) session could be replayed for 23 days
 * after the revocation "expired". Deriving the TTL from the token's own `exp`
 * makes over- and under-keeping impossible.
 */
async function blacklistToken(
  fastify: FastifyInstance,
  redis: ReturnType<typeof getRedis>,
  token: string,
  fallbackSeconds: number,
): Promise<void> {
  if (!redis || !token) return;
  let ttl = fallbackSeconds;
  try {
    const decoded = fastify.jwt.decode<{ exp?: number }>(token);
    if (decoded?.exp) {
      const remaining = decoded.exp - Math.floor(Date.now() / 1000);
      if (remaining > 0) ttl = remaining;
    }
  } catch {
    // Not decodable (already malformed): keep the fallback window.
  }
  await redis.setex(`bl_:${token}`, ttl, '1');
}

/** Access token from the Authorization header, else the SSE cookie. */
export function streamToken(req: FastifyRequest): string {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7);
  return readCookie(req.headers.cookie, SSE_COOKIE) || '';
}

export const authRoutes: FastifyPluginAsync = async (fastify) => {
  // The global limiter is 100/min for every route, which leaves ~100 password guesses
  // per minute here. Login and refresh are the only unauthenticated credential checks,
  // so they get their own much tighter budget.
  const AUTH_RATE_LIMIT = {
    config: {
      rateLimit: {
        max: 10,
        timeWindow: '1 minute',
        errorResponseBuilder: () => ({
          statusCode: 429,
          error: 'Too many attempts',
          message: 'Too many authentication attempts. Try again in a minute.',
        }),
      },
    },
  };

  fastify.post('/login', AUTH_RATE_LIMIT, async (req, reply) => {
    const parseResult = loginSchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply.status(400).send({ error: 'Invalid credentials' });
    }
    const { email, password } = parseResult.data;
    const sql = getDB();

    const user = await sql.unsafe(
      `SELECT id, email, password_hash, role FROM users WHERE email = $1`,
      [email],
    );

    if (!user || user.length === 0) {
      return reply.status(401).send({ error: 'Invalid credentials' });
    }
    const userRow = user[0]!;
    if (!userRow) {
      return reply.status(401).send({ error: 'Invalid credentials' });
    }

    const valid = await comparePassword(password, userRow.password_hash);
    if (!valid) {
      return reply.status(401).send({ error: 'Invalid credentials' });
    }

    const token = fastify.jwt.sign(
      { id: userRow.id, email: userRow.email, role: userRow.role },
      { expiresIn: '7d' },
    );
    const refreshToken = fastify.jwt.sign(
      { id: userRow.id, email: userRow.email, role: userRow.role, typ: 'refresh' },
      { expiresIn: '30d' },
    );

    // The refresh token leaves in an HttpOnly cookie, never in the body: anything
    // the body carries ends up in localStorage, where a single XSS or a malicious
    // transitive dependency can read it and mint fresh sessions for 30 days.
    reply.header('Set-Cookie', sessionCookies(token, refreshToken));

    return reply.send({
      access_token: token,
      token_type: 'Bearer',
      expires_in: ACCESS_TTL_SECONDS,
      user: {
        id: userRow.id,
        email: userRow.email,
        role: userRow.role,
      },
    });
  });

  fastify.post('/register', AUTH_RATE_LIMIT, async (req, reply) => {
    // Self-registration is default-deny. Every account created here is a
    // `sales_rep`, which can read lead PII, so an internet-reachable deployment
    // with this endpoint open let anyone self-provision access. Operators who
    // want it (single-tenant / dev) set ALLOW_SELF_REGISTRATION=true; otherwise
    // accounts are created by an admin via POST /users.
    if (!env.ALLOW_SELF_REGISTRATION) {
      return reply.status(403).send({
        error: 'Self-registration is disabled',
        message: 'Ask an administrator to create your account.',
      });
    }
    const parseResult = registerSchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply.status(400).send({ error: 'Invalid input', details: parseResult.error.issues });
    }
    const { email, password } = parseResult.data;
    const sql = getDB();

    const existing = await sql.unsafe(
      `SELECT id FROM users WHERE email = $1`,
      [email],
    );

    if (existing && existing.length > 0) {
      return reply.status(409).send({ error: 'User already exists' });
    }

    const hashedPassword = await hashPassword(password);

    const result = await sql.unsafe(
      `INSERT INTO users (email, password_hash, role, api_keys)
       VALUES ($1, $2, 'sales_rep', '{}')
       RETURNING id, email, role`,
      [email, hashedPassword],
    );

    return reply.status(201).send({
      message: 'User registered',
      user: result[0],
    });
  });

  fastify.post('/logout', { preHandler: [authenticate] }, async (req, reply) => {
    const redis = getRedis();
    const accessToken = streamToken(req);
    const refreshToken =
      readCookie(req.headers.cookie, REFRESH_COOKIE) ||
      ((req.body as { refresh_token?: string } | undefined)?.refresh_token ?? '');

    // Revoke BOTH lifetimes. Blacklisting only the access token left the refresh
    // token live for its full 30 days, so "sign out" on a shared machine did not
    // actually end the session -- anyone holding that token could mint a new one.
    await blacklistToken(fastify, redis, accessToken, ACCESS_TTL_SECONDS);
    await blacklistToken(fastify, redis, refreshToken, REFRESH_TTL_SECONDS);

    reply.header('Set-Cookie', clearSessionCookies());
    return { message: 'Logged out' };
  });

  fastify.post('/refresh', AUTH_RATE_LIMIT, async (req, reply) => {
    const bodySchema = z.object({
      refresh_token: z.string().min(1).optional(),
    });
    const parseResult = bodySchema.safeParse(req.body ?? {});
    if (!parseResult.success) {
      return reply.status(400).send({ error: 'Invalid body' });
    }

    // Cookie first. The body form is still accepted so a client that predates the
    // cookie migration (or a script) does not hard-break, but nothing we ship
    // sends it any more.
    const presented =
      readCookie(req.headers.cookie, REFRESH_COOKIE) || parseResult.data.refresh_token;
    if (!presented) {
      return reply.status(401).send({ error: 'No refresh token' });
    }

    const redis = getRedis();
    if (redis) {
      const existing = await redis.get(`bl_:${presented}`);
      if (existing) {
        return reply.status(401).send({ error: 'Token has been revoked' });
      }
    }

    try {
      const decoded = fastify.jwt.verify<{ id: string; typ?: string }>(presented);
      if (decoded.typ !== 'refresh') {
        return reply.status(401).send({ error: 'Invalid refresh token' });
      }
      const sql = getDB();
      const user = await sql.unsafe(
        `SELECT id, email, role FROM users WHERE id = $1`,
        [decoded.id],
      );

      const userRow = user[0] as unknown as { id: string; email: string; role: string };
      if (!userRow) {
        return reply.status(401).send({ error: 'Invalid refresh token' });
      }

      // Rotate: the presented token dies for its OWN remaining lifetime, not a
      // fixed 7d that expired 23 days before the token did.
      await blacklistToken(fastify, redis, presented, REFRESH_TTL_SECONDS);

      const token = fastify.jwt.sign(
        { id: userRow.id, email: userRow.email, role: userRow.role },
        { expiresIn: '7d' },
      );
      const refreshToken = fastify.jwt.sign(
        { id: userRow.id, email: userRow.email, role: userRow.role, typ: 'refresh' },
        { expiresIn: '30d' },
      );

      reply.header('Set-Cookie', sessionCookies(token, refreshToken));

      return reply.send({
        access_token: token,
        token_type: 'Bearer',
        expires_in: ACCESS_TTL_SECONDS,
        user: { id: userRow.id, email: userRow.email, role: userRow.role },
      });
    } catch (err) {
      return reply.status(401).send({ error: 'Invalid or expired refresh token' });
    }
  });
};
