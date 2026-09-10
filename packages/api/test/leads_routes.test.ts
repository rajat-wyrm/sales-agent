import { FastifyInstance } from 'fastify';

jest.mock('../src/middleware/auth', () => ({
  authenticate: jest.fn(async (req: any, _reply: any) => {
    req.user = { id: 'user-1', email: 'test@example.com', role: 'admin' };
  }),
  authorize: () => jest.fn(async (req: any, _reply: any) => {
    req.user = { id: 'user-1', email: 'test@example.com', role: 'admin' };
  }),
}));

jest.mock('../src/utils/db', () => ({
  getDB: () => ({ unsafe: mockSqlUnsafe }),
}));

jest.mock('../src/utils/redis', () => ({
  getRedis: () => ({ lpush: mockRedisLpush }),
}));

jest.mock('../src/utils/audit', () => ({
  logAuditEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/utils/sse', () => ({
  publishSSE: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/utils/scoring', () => ({
  recomputeLeadScore: mockRecomputeLeadScore,
}));

const mockSqlUnsafe = jest.fn();
const mockRedisLpush = jest.fn();
const mockRecomputeLeadScore = jest.fn();

describe('Leads API - do_not_contact enforcement (SRS §13.2)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    mockSqlUnsafe.mockReset();
    mockRedisLpush.mockReset();
    mockRecomputeLeadScore.mockReset();
    mockRedisLpush.mockResolvedValue(1);
    mockRecomputeLeadScore.mockResolvedValue(50);

    const fastify = (require('fastify') as () => FastifyInstance)();

    const { leadsRoutes } = require('../src/routes/leads');
    fastify.register(leadsRoutes, { prefix: '/leads' });
    app = fastify;
    await app.ready();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  test('send to do_not_contact lead returns 403', async () => {
    mockSqlUnsafe.mockImplementation(async (query: string) => {
      if (query.includes('do_not_contact')) {
        return [{ do_not_contact: true, email_status: 'valid', whatsapp_status: 'registered' }];
      }
      return [];
    });

    const response = await app.inject({
      method: 'POST',
      url: '/leads/550e8400-e29b-41d4-a716-446655440000/send',
      payload: { channel: 'email' },
    });

    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body)).toEqual(
      expect.objectContaining({ error: 'Cannot send to do-not-contact lead' })
    );
  });

  test('send to non-flagged lead with verified email succeeds', async () => {
    mockSqlUnsafe.mockImplementation(async (query: string) => {
      if (query.includes('do_not_contact')) {
        return [{ do_not_contact: false, email_status: 'valid', whatsapp_status: 'registered' }];
      }
      return [];
    });

    const response = await app.inject({
      method: 'POST',
      url: '/leads/550e8400-e29b-41d4-a716-446655440000/send',
      payload: { channel: 'email' },
    });

    expect(response.statusCode).toBe(202);
    expect(mockRedisLpush).toHaveBeenCalledWith(
      'send_queue:requests',
      expect.stringContaining('550e8400-e29b-41d4-a716-446655440000'),
    );
  });

  test('send with invalid email status returns 400', async () => {
    mockSqlUnsafe.mockImplementation(async (query: string) => {
      if (query.includes('do_not_contact')) {
        return [{ do_not_contact: false, email_status: 'invalid', whatsapp_status: 'registered' }];
      }
      return [];
    });

    const response = await app.inject({
      method: 'POST',
      url: '/leads/550e8400-e29b-41d4-a716-446655440000/send',
      payload: { channel: 'email' },
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual(
      expect.objectContaining({ error: 'Email not verified' })
    );
  });

  test('verify endpoint enqueues job for verification queue', async () => {
    mockSqlUnsafe.mockResolvedValue([]);

    const response = await app.inject({
      method: 'POST',
      url: '/leads/550e8400-e29b-41d4-a716-446655440000/verify',
      payload: {},
    });

    expect(response.statusCode).toBe(202);
    expect(mockRedisLpush).toHaveBeenCalledWith(
      'verification_queue:requests',
      expect.stringContaining('550e8400-e29b-41d4-a716-446655440000'),
    );
  });

  test('enrich endpoint enqueues job for enrichment queue', async () => {
    mockSqlUnsafe.mockResolvedValue([]);

    const response = await app.inject({
      method: 'POST',
      url: '/leads/550e8400-e29b-41d4-a716-446655440000/enrich',
      payload: {},
    });

    expect(response.statusCode).toBe(202);
    expect(mockRedisLpush).toHaveBeenCalledWith(
      'enrichment_queue:requests',
      expect.stringContaining('550e8400-e29b-41d4-a716-446655440000'),
    );
  });

  test('draft endpoint enqueues job for draft queue', async () => {
    mockSqlUnsafe.mockResolvedValue([]);

    const response = await app.inject({
      method: 'POST',
      url: '/leads/550e8400-e29b-41d4-a716-446655440000/draft',
      payload: { channel: 'both' },
    });

    expect(response.statusCode).toBe(202);
    expect(mockRedisLpush).toHaveBeenCalledWith(
      'draft_queue:requests',
      expect.stringContaining('550e8400-e29b-41d4-a716-446655440000'),
    );
  });
});
