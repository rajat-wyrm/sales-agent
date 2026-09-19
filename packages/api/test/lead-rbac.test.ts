import { FastifyInstance } from 'fastify';

/**
 * Every single-lead route must apply the same ownership rule: a sales_rep may act only on
 * leads assigned to them. GET /:id and PATCH /:id/assign already did; timeline, bulk-draft
 * and merge-duplicate did not, which let any rep read another's outreach history, queue
 * work on their leads, or delete one outright (merge deletes the source row).
 *
 * The mock answers the ownership predicate by echoing it back, so these tests assert the
 * guard is *present and consulted*, and that a non-owner gets 404 rather than a mutation.
 */

let currentUser: { id: string; email: string; role: string };
let ownedByCaller: string[];          // ids the fake DB says belong to currentUser
const executed: Array<{ sql: string; params: any[] }> = [];

jest.mock('../src/middleware/auth', () => ({
  authenticate: jest.fn(async (_req: any, _reply: any) => {
    _req.user = currentUser;
  }),
  authorize: (_roles: string[]) => jest.fn(async (req: any) => { req.user = currentUser; }),
}));
jest.mock('../src/utils/db', () => ({ getDB: () => ({ unsafe: mockUnsafe }) }));
jest.mock('../src/utils/redis', () => ({ getRedis: () => ({ lpush: mockLpush }) }));
jest.mock('../src/utils/audit', () => ({ logAuditEvent: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/utils/sse', () => ({ publishSSE: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/utils/scoring', () => ({ recomputeLeadScore: jest.fn(), scoreExplain: jest.fn() }));

async function mockUnsafe(query: string, params: any[] = []) {
  executed.push({ sql: query, params });
  if (/SELECT 1 FROM leads WHERE id = \$1$/.test(query)) {
    return [{ '?column?': 1 }]; // admin existence probe
  }
  if (/SELECT 1 FROM leads WHERE id = \$1/.test(query)) {
    // canReadLead: owned OR unclaimed pool. THEIRS is owned by someone else
    // (claimed); MINE is owned by the caller; UNCLAIMED is the claim pool.
    return ownedByCaller.includes(params[0]) || params[0] === UNCLAIMED
      ? [{ '?column?': 1 }]
      : [];
  }
  if (/id = ANY\(\$1::uuid\[\]\)/.test(query) && /assigned_to/.test(query)) {
    const [, role, uid] = params as any[];
    return (params[0] as string[]).filter((leadId: string) => role === 'admin' || ownedByCaller.includes(leadId + ':' + uid) || ownedByCaller.includes(leadId))
      .map((leadId: string) => ({ id: leadId }));
  }
  if (/UPDATE leads SET do_not_contact/.test(query)) {
    return ownedByCaller.includes(params[1]) ? [{ id: params[1] }] : [];
  }
  return [];
}
const mockLpush = jest.fn().mockResolvedValue(1);

const MINE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const THEIRS = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const UNCLAIMED = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

describe('per-lead RBAC across every mutating/reading route', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    executed.length = 0;
    ownedByCaller = [MINE];
    currentUser = { id: 'rep-1', email: 'rep@test', role: 'sales_rep' };
    const fastify = (require('fastify') as () => FastifyInstance)();
    const { leadsRoutes } = require('../src/routes/leads');
    fastify.register(leadsRoutes, { prefix: '/leads' });
    app = fastify;
    await app.ready();
  });
  afterEach(async () => { await app.close(); });

  test('timeline for someone else\'s lead is 404 and leaks nothing', async () => {
    const res = await app.inject({ method: 'GET', url: `/leads/${THEIRS}/timeline` });
    expect(res.statusCode).toBe(404);
    // no provider/draft/outreach table was touched for a lead we do not own
    expect(executed.some((e) => /enrichment_log|verification_log|outreach_drafts/.test(e.sql))).toBe(false);
  });

  test('timeline for my lead works and does consult ownership', async () => {
    const res = await app.inject({ method: 'GET', url: `/leads/${MINE}/timeline` });
    expect(res.statusCode).toBe(200);
    expect(executed.some((e) => /assigned_to/.test(e.sql) && /claimed_by/.test(e.sql))).toBe(true);
  });

  test('timeline for an unclaimed lead is readable (claim pool inspection)', async () => {
    const res = await app.inject({ method: 'GET', url: `/leads/${UNCLAIMED}/timeline` });
    expect(res.statusCode).toBe(200);
  });

  test('admin may read any timeline', async () => {
    currentUser = { id: 'adm', email: 'a@t', role: 'admin' };
    const res = await app.inject({ method: 'GET', url: `/leads/${THEIRS}/timeline` });
    expect(res.statusCode).toBe(200);
  });

  test('bulk-draft drops leads the caller does not own instead of queueing them', async () => {
    const res = await app.inject({
      method: 'POST', url: '/leads/bulk-draft',
      payload: { lead_ids: [MINE, THEIRS], channel: 'both' },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.lead_ids).toEqual([MINE]);
    expect(body.rejected_lead_ids).toEqual([THEIRS]);
    // what actually went to the worker must be the filtered set
    const queued = JSON.parse(mockLpush.mock.calls[0][1]);
    expect(queued.lead_ids).toEqual([MINE]);
  });

  test('bulk-draft with none owned is refused outright', async () => {
    const res = await app.inject({
      method: 'POST', url: '/leads/bulk-draft', payload: { lead_ids: [THEIRS] },
    });
    expect(res.statusCode).toBe(403);
  });

  test('merge-duplicate cannot destroy another rep\'s lead', async () => {
    const res = await app.inject({
      method: 'POST', url: `/leads/${THEIRS}/merge-duplicate`,
      payload: { merge_into_id: MINE },
    });
    expect(res.statusCode).toBe(404);
    expect(executed.some((e) => /DELETE FROM leads/.test(e.sql))).toBe(false);
    expect(executed.some((e) => /UPDATE enrichment_log SET lead_id/.test(e.sql))).toBe(false);
  });

  test('merge-duplicate cannot re-parent history onto a lead the caller does not own', async () => {
    const res = await app.inject({
      method: 'POST', url: `/leads/${MINE}/merge-duplicate`,
      payload: { merge_into_id: THEIRS },
    });
    expect(res.statusCode).toBe(404);
    expect(executed.some((e) => /DELETE FROM leads/.test(e.sql))).toBe(false);
  });

  test('merge between two of my own leads proceeds', async () => {
    ownedByCaller = [MINE, THEIRS];   // now both belong to the caller
    const res = await app.inject({
      method: 'POST', url: `/leads/${MINE}/merge-duplicate`,
      payload: { merge_into_id: THEIRS },
    });
    expect(res.statusCode).toBe(200);
    expect(executed.some((e) => /DELETE FROM leads/.test(e.sql))).toBe(true);
  });
});
