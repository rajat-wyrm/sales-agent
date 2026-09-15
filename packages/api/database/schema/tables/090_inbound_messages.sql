/*
 * Inbound correspondence.

 * The Resend/WhatsApp webhook already detects replies (webhooks.ts sets
 * outreach_log.delivery_status = 'replied' and moves the lead stage), but it keeps
 * no copy of what the person wrote. That means a follow-up draft cannot see an
 * objection, an unsubscribe request, or "send this to my manager" -- it would reply
 * as if nothing had happened.

 * Outbound history needed NO new table: outreach_log.draft_id joins to
 * outreach_drafts.subject/body, so everything we sent is already reconstructable.
 * This stores only the inbound direction, which genuinely has nowhere to live.

 * GDPR: erasure must clear this too -- it holds raw third-party message content.
 */

CREATE TABLE IF NOT EXISTS inbound_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id UUID REFERENCES leads(id) ON DELETE CASCADE,
    outreach_log_id UUID REFERENCES outreach_log(id) ON DELETE SET NULL,
    channel TEXT NOT NULL CHECK (channel IN ('email', 'whatsapp')),
    direction TEXT NOT NULL DEFAULT 'inbound' CHECK (direction = 'inbound'),
    sender_identity TEXT,
    subject TEXT,
    body_text TEXT NOT NULL,
    provider_message_id TEXT,
    -- Unsubscribe / do-not-contact intent detected in the text, so compliance can
    -- act on it without re-reading bodies.
    is_unsubscribe BOOLEAN NOT NULL DEFAULT FALSE,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS inbound_lead_recent_idx
    ON inbound_messages (lead_id, received_at DESC);
CREATE INDEX IF NOT EXISTS inbound_provider_msg_idx
    ON inbound_messages (provider_message_id) WHERE provider_message_id IS NOT NULL;

COMMENT ON TABLE inbound_messages IS
    'Inbound replies only; outbound lives in outreach_drafts joined via outreach_log.';
