import { FastifyPluginAsync } from 'fastify';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { getDB } from '../utils/db';
import { getRedis } from '../utils/redis';
import { authenticate } from '../middleware/auth';
import { authorize } from '../middleware/auth';
import { encryptApiKeys, decryptApiKeys, maskApiKeys } from '../utils/crypto';
import { logAuditEvent } from '../utils/audit';

const triggerRunSchema = z.object({
  sources: z.array(z.string()).optional(),
});

const settingsSchema = z.object({
  api_keys: z.object({
    snovio: z.string().optional(),
    contactout: z.string().optional(),
    resend: z.string().optional(),
    brevo: z.string().optional(),
    gemini: z.string().optional(),
    whatsapp: z.string().optional(),
  }).optional(),
  scraper_config: z.object({
    max_concurrency: z.number().min(1).optional(),
    timeout_seconds: z.number().min(1).optional(),
  }).optional(),
  scoring_weights: z.record(z.number().min(0).max(100)).optional(),
  cron_schedule: z.string().min(1).optional(),
  sources_enabled: z.record(z.boolean()).optional(),
});

export const adminRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', authenticate);

  fastify.post(
    '/runs/trigger',
    { preValidation: [authorize(['admin'])] },
    async (req, reply) => {
      const parseResult = triggerRunSchema.safeParse(req.body || {});
      if (!parseResult.success) {
        return reply.status(400).send({ error: 'Invalid body' });
      }
      const { sources } = parseResult.data;

      const redis = getRedis();
      const runId = randomUUID();
      await redis.lpush(
        'scrape_queue:requests',
        JSON.stringify({
          run_id: runId,
          run_type: 'manual',
          sources: sources || null,
          triggered_by: (req.user as { id: string }).id,
          triggered_at: new Date().toISOString(),
        }),
      );

      await logAuditEvent({
        user_id: (req.user as { id: string }).id,
        action: 'trigger_run',
        resource_type: 'scrape_run',
        resource_id: runId,
        details: { sources },
      });

      return reply.status(202).send({
        message: 'Scrape run triggered',
        job_id: runId,
        sources: sources || 'all',
      });
    },
  );

  fastify.post(
    '/runs/army',
    { preValidation: [authorize(['admin'])] },
    async (req, reply) => {
      // One-click army run: scrape every source AND immediately re-enrich any
      // lead still missing a contact. The Python workers own the queue + sweep;
      // this endpoint just authenticates and forwards, so the browser never
      // talks to the internal worker service directly.
      const parseResult = triggerRunSchema.safeParse(req.body || {});
      if (!parseResult.success) {
        return reply.status(400).send({ error: 'Invalid body' });
      }
      const workersUrl = process.env.WORKERS_URL || 'http://workers:8000';
      const triggeredBy = (req.user as { id: string }).id;
      try {
        const res = await fetch(`${workersUrl}/army/run`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sources: parseResult.data.sources || null, triggered_by: triggeredBy }),
        });
        const data = await res.json();
        await logAuditEvent({
          user_id: triggeredBy,
          action: 'trigger_army',
          resource_type: 'scrape_run',
          resource_id: (data as any)?.run_id || 'army',
          details: { sweep_reenqueued: (data as any)?.sweep_reenqueued },
        });
        return reply.status(res.ok ? 202 : 502).send(data);
      } catch (err) {
        return reply.status(502).send({ error: 'Worker army trigger unreachable', detail: (err as Error).message });
      }
    },
  );

  fastify.get(
    '/army/status',
    { preValidation: [authorize(['admin', 'sales_rep'])] },
    async (_req, reply) => {
      const workersUrl = process.env.WORKERS_URL || 'http://workers:8000';
      try {
        const res = await fetch(`${workersUrl}/army/status`, { method: 'GET' });
        return reply.send(await res.json());
      } catch (err) {
        return reply.status(502).send({ error: 'Worker status unreachable', detail: (err as Error).message });
      }
    },
  );

  fastify.get('/runs/:id', { preValidation: [authorize(['admin'])] }, async (req, reply) => {
    const paramsSchema = z.object({ id: z.string().uuid() });
    const parseResult = paramsSchema.safeParse(req.params);
    if (!parseResult.success) {
      return reply.status(400).send({ error: 'Invalid run ID' });
    }
    const { id } = parseResult.data;
    const sql = getDB();

    const run = await sql.unsafe(
      `SELECT * FROM scrape_runs WHERE id = $1`,
      [id],
    );

    if (!run || run.length === 0) {
      return reply.status(404).send({ error: 'Run not found' });
    }

    return { run: run[0] };
  });

  const runsListSchema = z.object({
    limit: z.coerce.number().min(1).max(100).default(10),
  });

  fastify.get('/runs', { preValidation: [authorize(['admin'])] }, async (req, reply) => {
    const parseResult = runsListSchema.safeParse(req.query);
    if (!parseResult.success) {
      return reply.status(400).send({ error: 'Invalid query parameters', details: parseResult.error.issues });
    }
    const { limit } = parseResult.data;
    const sql = getDB();

    const runs = await sql.unsafe(
      `SELECT id, started_at, finished_at, sources_attempted, sources_succeeded,
              sources_circuit_broken, leads_found, leads_deduped, errors
       FROM scrape_runs
       ORDER BY started_at DESC
       LIMIT $1`,
      [limit],
    );

    return { runs };
  });

  fastify.put(
    '/settings/api-keys',
    { preValidation: [authorize(['admin'])] },
    async (req, reply) => {
      const parseResult = settingsSchema.safeParse(req.body);
      if (!parseResult.success) {
        return reply.status(400).send({ error: 'Invalid body', details: parseResult.error.issues });
      }
      const { api_keys } = parseResult.data;

      const sql = getDB();
      const encryptedKeys = api_keys
        ? encryptApiKeys({
            snovio: api_keys.snovio,
            contactout: api_keys.contactout,
            resend: api_keys.resend,
            brevo: api_keys.brevo,
            gemini: api_keys.gemini,
            whatsapp: api_keys.whatsapp,
          })
        : {};

      await sql.unsafe(
        `UPDATE users SET api_keys = $1::jsonb, updated_at = NOW() WHERE id = $2`,
        [JSON.stringify(encryptedKeys), (req.user as { id: string }).id],
      );

      await logAuditEvent({
        user_id: (req.user as { id: string }).id,
        action: 'update_api_keys',
        resource_type: 'user',
        resource_id: (req.user as { id: string }).id,
      });

      return { message: 'API keys updated' };
    },
  );

  fastify.get('/sources/health', async (_req, _reply) => {
    const sql = getDB();
    const health = await sql.unsafe(`
      SELECT source_name, consecutive_failures, circuit_open_until, last_success_at, last_failure_reason
      FROM source_health
      ORDER BY source_name
    `);

    return { sources: health };
  });

  fastify.get('/users', { preValidation: [authorize(['admin'])] }, async (_req, _reply) => {
    const sql = getDB();
    const users = await sql.unsafe(`
      SELECT id, email, role, created_at
      FROM users
      ORDER BY email ASC
    `);

    return { users };
  });

  fastify.get('/settings/api-keys', { preValidation: [authorize(['admin'])] }, async (req, reply) => {
    const sql = getDB();
    const result = await sql.unsafe(
      `SELECT api_keys FROM users WHERE id = $1`,
      [(req.user as { id: string }).id],
    );

    if (!result || result.length === 0) {
      return reply.status(404).send({ error: 'User not found' });
    }

    // SECURITY: never return decrypted provider secrets to the client. Report
    // only a masked view (last-4) so the UI can show state without exfiltrating
    // credentials. decryptApiKeys stays used elsewhere for server-side calls.
    void decryptApiKeys;
    let masked: Record<string, string> = {};
    if (result[0]?.api_keys) {
      const parsedKeys =
        typeof result[0].api_keys === 'string'
          ? JSON.parse(result[0].api_keys)
          : result[0].api_keys;
      masked = maskApiKeys(parsedKeys);
    }

    return { api_keys: masked };
  });

  fastify.get('/settings/:key', { preValidation: [authorize(['admin'])] }, async (req, reply) => {
    const sql = getDB();
    const key = (req.params as { key: string }).key;
    const result = await sql.unsafe(
      `SELECT value FROM settings WHERE key = $1`,
      [key],
    );

    if (!result || result.length === 0) {
      return { key, value: null };
    }

    return { key, value: result?.[0]?.value ?? null };
  });

  fastify.put('/settings', { preValidation: [authorize(['admin'])] }, async (req, reply) => {
    const parseResult = settingsSchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply.status(400).send({ error: 'Invalid body', details: parseResult.error.issues });
    }
    const settings = parseResult.data;
    const sql = getDB();

    await logAuditEvent({
      user_id: (req.user as { id: string }).id,
      action: 'update_settings',
      resource_type: 'settings',
      resource_id: '',
    });

    const results: Record<string, any> = {};
    for (const [key, value] of Object.entries(settings)) {
      await sql.unsafe(
        `INSERT INTO settings (key, value, updated_by, updated_at)
         VALUES ($1, $2::jsonb, $3, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
        [key, JSON.stringify(value), (req.user as { id: string }).id],
      );
      results[key] = value;
    }

    return { message: 'Settings updated', updated: results };
  });

  // ---- Suppression / do-not-contact list (server-side, non-negotiable) -----
  // Admins manage the global blocklist here; the send worker + webhook opt-outs
  // both write to it, and outreach is blocked whenever a contact matches.
  const suppressionSchema = z.object({
    contact: z.string().min(1),
    channel: z.enum(['email', 'whatsapp', 'any']).default('any'),
    reason: z.enum(['opted_out', 'bounced', 'blocked', 'provider_rejected', 'compliance_hold', 'manual']).default('manual'),
  });

  fastify.get('/suppressions', { preValidation: [authorize(['admin'])] }, async (_req, reply) => {
    const sql = getDB();
    const rows = await sql.unsafe(
      `SELECT id, normalized_contact, channel, reason, source, created_at
       FROM suppressions ORDER BY created_at DESC LIMIT 1000`,
    );
    return reply.send({ suppressions: rows });
  });

  fastify.post('/suppressions', { preValidation: [authorize(['admin'])] }, async (req, reply) => {
    const parsed = suppressionSchema.safeParse(req.body || {});
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid body', details: parsed.error.issues });
    const { contact, channel, reason } = parsed.data;
    const normalized = String(contact).trim().toLowerCase();
    const sql = getDB();
    await sql.unsafe(
      `INSERT INTO suppressions (normalized_contact, channel, reason, source)
       VALUES ($1, $2, $3, 'manual')
       ON CONFLICT (normalized_contact, channel) DO UPDATE SET reason = EXCLUDED.reason`,
      [normalized, channel, reason],
    );
    // Also flag matching leads do_not_contact so in-flight leads stop immediately.
    if (channel !== 'whatsapp') {
      await sql.unsafe(
        `UPDATE leads SET do_not_contact = true, updated_at = NOW()
         WHERE id IN (SELECT l.id FROM leads l JOIN hr_contacts hc ON l.hr_contact_id = hc.id
                      WHERE lower(hc.personal_email) = $1)`,
        [normalized],
      );
    }
    await logAuditEvent({
      user_id: (req.user as { id: string }).id,
      action: 'add_suppression',
      resource_type: 'suppression',
      resource_id: '',
      details: { channel, reason }, // NOTE: do not log the contact PII itself
    });
    return reply.status(201).send({ message: 'Contact suppressed' });
  });

  fastify.delete('/suppressions/:id', { preValidation: [authorize(['admin'])] }, async (req, reply) => {
    const idResult = z.string().uuid().safeParse((req.params as { id: string }).id);
    if (!idResult.success) return reply.status(400).send({ error: 'Invalid id' });
    const sql = getDB();
    const n = await sql.unsafe(`DELETE FROM suppressions WHERE id = $1 RETURNING id`, [idResult.data]);
    if (!n || n.length === 0) return reply.status(404).send({ error: 'Not found' });
    await logAuditEvent({
      user_id: (req.user as { id: string }).id,
      action: 'remove_suppression',
      resource_type: 'suppression',
      resource_id: idResult.data,
    });
    return { message: 'Suppression removed' };
  });
};
