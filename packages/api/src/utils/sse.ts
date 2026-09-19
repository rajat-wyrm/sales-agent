import { getDB } from './db';
import { getRedis } from './redis';
import { retry } from './httpClient';

type SSEEvent = {
  type: string;
  lead_id?: string;
  [key: string]: unknown;
};

/**
 * Channel names, fixed contract with the Python workers (scrapers/queue.py).
 *
 *   user:{id}:sse  - one user's own events + events for leads they own
 *   shared:sse     - events for leads that are UNASSIGNED. The REST API lets
 *                    every authenticated user read those rows (leads.ts
 *                    `ownership=unclaimed`, and getLeadForUser's "claimed_by IS
 *                    NULL AND assigned_to IS NULL" clause), so this channel's
 *                    audience is exactly the set of users already permitted to
 *                    see them.
 *   ops:sse        - deployment-wide operations (scrape runs). Admin-only;
 *                    /runs and /runs/trigger are admin-gated, so reps must not
 *                    receive these.
 *
 * There is deliberately no wildcard "everyone" channel any more: the previous
 * broadcast:sse delivered every lead event to every logged-in user, so a
 * sales_rep's browser received ids and outcomes for leads belonging to other
 * reps -- and `EventSource` has no way to un-receive them.
 */
export const SHARED_CHANNEL = 'shared:sse';
export const OPS_CHANNEL = 'ops:sse';

/** Assigned/claimed owners of a lead, or null when the lead has no owner. */
async function leadAudience(leadId: string): Promise<string[] | null> {
  const rows = await getDB().unsafe(
    `SELECT assigned_to, claimed_by FROM leads WHERE id = $1`,
    [leadId],
  );
  const row = (rows as unknown as Array<{ assigned_to: string | null; claimed_by: string | null }>)[0];
  if (!row) return null;
  if (!row.assigned_to && !row.claimed_by) return [];
  const ids: string[] = [];
  if (row.assigned_to) ids.push(row.assigned_to);
  if (row.claimed_by) ids.push(row.claimed_by);
  return ids;
}

export async function publishSSE(
  userId: string,
  event: SSEEvent,
  audience: string[] = [],
): Promise<void> {
  const channels = new Set<string>(audience.filter(Boolean).map((id) => `user:${id}:sse`));
  if (userId) channels.add(`user:${userId}:sse`);

  if (event.lead_id) {
    try {
      const owners = await leadAudience(event.lead_id);
      if (owners === null) {
        // Lead row is gone (deleted between enqueue and completion): nobody can
        // be looking at it, so the actor's channel alone is the right audience.
      } else if (owners.length === 0) {
        channels.add(SHARED_CHANNEL);
      } else {
        owners.forEach((id) => channels.add(`user:${id}:sse`));
      }
    } catch (err) {
      // Fail soft rather than dropping the event: the actor still gets their own
      // update, and the next refetch reconciles anything missed. Widening to a
      // shared channel here would re-introduce the leak on every DB blip.
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[SSE] audience lookup failed, delivering to actor only:', msg);
    }
  } else {
    channels.add(OPS_CHANNEL);
  }

  if (channels.size === 0) channels.add(OPS_CHANNEL);

  const body = JSON.stringify(event);
  for (const channel of channels) {
    try {
      await retry(async () => {
        await getRedis().publish(channel, body);
      }, { retries: 3, minTimeout: 200, maxTimeout: 2000, retryableErrors: ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT'] });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[SSE] Failed to publish event to ${channel} after retries:`, msg);
    }
  }
}
