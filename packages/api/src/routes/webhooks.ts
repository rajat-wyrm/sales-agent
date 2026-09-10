import { FastifyPluginAsync } from 'fastify';
import { createHmac, timingSafeEqual } from 'crypto';
import { z } from 'zod';
import { getDB } from '../utils/db';
import { env } from '../utils/env';
import { logAuditEvent } from '../utils/audit';

// Verifies a svix-style signature header (Resend webhooks) or Meta X-Hub-Signature-256
// against the raw request body. Rejects the request when a secret is configured but
// the signature does not match; allows all traffic when no secret is configured (dev).
function verifySignature(
  secret: string | undefined,
  headers: Record<string, string | string[] | undefined>,
  rawBody: string,
  scheme: 'svix' | 'meta',
): boolean {
  if (!secret) return true; // ponytail: no secret configured -> dev mode; set RESEND_WEBHOOK_SECRET / WHATSAPP_APP_SECRET in prod
  const headerNames: Record<typeof scheme, { sig: string; id?: string; ts?: string }> = {
    svix: { sig: 'svix-signature', id: 'svix-id', ts: 'svix-timestamp' },
    meta: { sig: 'x-hub-signature-256' },
  };
  const names = headerNames[scheme];
  const rawSig = headers[names.sig];
  if (!rawSig) return false;
  const sig = Array.isArray(rawSig) ? rawSig[0] : rawSig;

  if (scheme === 'svix') {
    const id = headers['svix-id'];
    const tsRaw = headers['svix-timestamp'];
    const ts = typeof tsRaw === 'string' ? Number(tsRaw) : NaN;
    if (!id || !Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;
    const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
    const expected = createHmac('sha256', key)
      .update(`${id}.${ts}.${rawBody}`)
      .digest('base64');
    return sig.split(' ').some((part) => {
      const [version, digest] = part.split(',');
      if (version !== 'v1' || !digest) return false;
      const a = Buffer.from(digest);
      const b = Buffer.from(expected);
      return a.length === b.length && timingSafeEqual(a, b);
    });
  }

  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const resendWebhookSchema = z.object({
  type: z.string(),
  data: z.record(z.unknown()),
});

const whatsappWebhookSchema = z.object({
  entry: z.array(z.record(z.unknown())).optional(),
  object: z.string().optional(),
  message: z.record(z.unknown()).optional(),
});

export const webhookRoutes: FastifyPluginAsync = async (fastify) => {
  // Keep the exact raw body around so webhook signatures can be verified.
  // Scoped to this plugin (only webhook routes), so other routes keep their parser.
  fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as unknown as { rawBody?: string }).rawBody = body as string;
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  fastify.post('/resend', async (req, reply) => {
    const rawBody =
      (req as unknown as { rawBody?: string }).rawBody || JSON.stringify(req.body);
    if (!verifySignature(env.RESEND_WEBHOOK_SECRET, req.headers, rawBody, 'svix')) {
      return reply.status(401).send({ error: 'Invalid webhook signature' });
    }
    const parseResult = resendWebhookSchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply.status(400).send({ error: 'Invalid webhook payload' });
    }
    const { type, data } = parseResult.data;
    const sql = getDB();

    if (type === 'email.sent' || type === 'email.delivered') {
      const messageId = data.message_id as string;

      await sql.unsafe(
        `UPDATE outreach_log
         SET delivery_status = 'delivered'
         WHERE provider_message_id = $1`,
        [messageId],
      );

      await sql.unsafe(
        `UPDATE leads SET pipeline_stage = 'contacted'
         WHERE id = (SELECT lead_id FROM outreach_log WHERE provider_message_id = $1 LIMIT 1)`,
        [messageId],
      );
    }

    if (type === 'email.bounced') {
      const recipient = data.recipient as string;
      const messageId = data.message_id as string;

      await sql.unsafe(
        `UPDATE outreach_log
         SET delivery_status = 'bounced'
         WHERE provider_message_id = $1`,
        [messageId],
      );

      await sql.unsafe(
        `UPDATE leads SET pipeline_stage = 'bounced', do_not_contact = true
         WHERE id = (SELECT lead_id FROM outreach_log WHERE provider_message_id = $1 LIMIT 1)`,
        [messageId],
      );

      await logAuditEvent({
        user_id: null,
        action: 'email_bounced',
        resource_type: 'lead',
        resource_id: null,
        details: { recipient, message_id: messageId },
      });
    }

    if (type === 'email.complained') {
      const recipient = data.recipient as string;
      // leads has no email column — complaints must resolve through the HR contact email
      await sql.unsafe(
        `UPDATE leads SET pipeline_stage = 'bounced', do_not_contact = true
         WHERE id = (
           SELECT l.id FROM leads l
           JOIN hr_contacts hc ON l.hr_contact_id = hc.id
           WHERE hc.personal_email = $1
           LIMIT 1
         )`,
        [recipient],
      );

      await logAuditEvent({
        user_id: null,
        action: 'email_complaint',
        resource_type: 'lead',
        resource_id: null,
        details: { recipient },
      });
    }

    if (type === 'email.replied' || type === 'email.reply') {
      const recipient = data.recipient as string;
      const messageId = data.message_id as string;

      await sql.unsafe(
        `UPDATE outreach_log
         SET delivery_status = 'replied'
         WHERE provider_message_id = $1`,
        [messageId],
      );

      await sql.unsafe(
        `UPDATE leads SET pipeline_stage = 'replied'
         WHERE id = (SELECT lead_id FROM outreach_log WHERE provider_message_id = $1 LIMIT 1)`,
        [messageId],
      );

      await logAuditEvent({
        user_id: null,
        action: 'email_reply_received',
        resource_type: 'lead',
        resource_id: null,
        details: { recipient, message_id: messageId },
      });
    }

    return { status: 'ok' };
  });

  fastify.post('/whatsapp', async (req, reply) => {
    const rawBody =
      (req as unknown as { rawBody?: string }).rawBody || JSON.stringify(req.body);
    if (!verifySignature(env.WHATSAPP_APP_SECRET, req.headers, rawBody, 'meta')) {
      return reply.status(401).send({ error: 'Invalid webhook signature' });
    }
    const parseResult = whatsappWebhookSchema.safeParse(req.body);
    if (!parseResult.success) {
      return { status: 'ok' };
    }
    const sql = getDB();

    const body = parseResult.data as any;

    if (body.entry && Array.isArray(body.entry)) {
      for (const entry of body.entry) {
        const changes = (entry as any).changes;
        if (changes && Array.isArray(changes)) {
          for (const change of changes) {
            const value = change?.value;
            if (value?.messages && Array.isArray(value.messages)) {
              for (const msg of value.messages) {
                const from = msg.from as string;
                const msgBody = msg.text?.body as string;

                const leadResult = await sql.unsafe(
                  `SELECT l.id FROM leads l
                   JOIN companies c ON l.company_id = c.id
                   WHERE c.default_phone = $1`,
                  [from],
                );

                if (leadResult && leadResult.length > 0) {
                  await sql.unsafe(
                    `UPDATE leads SET pipeline_stage = 'replied', updated_at = NOW()
                     WHERE id = $1`,
                    [(leadResult as any[])[0].id],
                  );
                }

                await logAuditEvent({
                  user_id: null,
                  action: 'whatsapp_message_received',
                  resource_type: 'lead',
                  resource_id: leadResult?.[0]?.id || null,
                  details: { from, message: msgBody },
                });
              }
            }
          }
        }
      }
    }

    return { status: 'ok' };
  });
};
