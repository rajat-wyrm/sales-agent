-- constraints/constraints.sql — single source of truth for CONSTRAINTS (fresh-install schema).
-- Sections below are the former split files, kept in dependency order.
-- Idempotent: safe to re-run on every boot. Deployed-DB deltas live in database/migrations/.

-- ==================== [010_users_role_check.sql] ====================
DO $$ BEGIN
  ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
  ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'sales_rep', 'viewer'));
EXCEPTION WHEN duplicate_object THEN NULL; WHEN check_violation THEN NULL; END $$;

-- ==================== [020_leads_pipeline_stage_check.sql] ====================
-- Lead lifecycle state machine (happy path + every failure state the spec lists).
-- NOTE: 'contacted' is the legacy alias of 'sent' still written by workers/webhooks.
DO $$ BEGIN
  ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_pipeline_stage_chk;
  ALTER TABLE leads ADD CONSTRAINT leads_pipeline_stage_chk CHECK (pipeline_stage IN (
    'discovered','enriching','enriched','verifying','verified','drafted','contacted',
    'ready_for_outreach','message_generated','send_pending','sent','delivered','replied','converted','bounced',
    'enrichment_failed','verification_failed','contact_unavailable','suppressed','send_failed','provider_error','retry_pending'));
EXCEPTION WHEN duplicate_object THEN NULL; WHEN check_violation THEN NULL; END $$;

-- ==================== [030_leads_email_status_check.sql] ====================
-- Discovery and verification are distinct: email_status records an actual
-- verification outcome (or pending/unknown), never a guessed "verified".
DO $$ BEGIN
  ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_email_status_chk;
  ALTER TABLE leads ADD CONSTRAINT leads_email_status_chk CHECK (email_status IS NULL OR email_status IN (
    'unknown','valid','invalid','catch_all','disposable','expired','pending'));
EXCEPTION WHEN duplicate_object THEN NULL; WHEN check_violation THEN NULL; END $$;

-- ==================== [040_leads_whatsapp_status_check.sql] ====================
DO $$ BEGIN
  ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_whatsapp_status_chk;
  ALTER TABLE leads ADD CONSTRAINT leads_whatsapp_status_chk CHECK (whatsapp_status IS NULL OR whatsapp_status IN (
    'unknown','registered','not_registered','expired','pending'));
EXCEPTION WHEN duplicate_object THEN NULL; WHEN check_violation THEN NULL; END $$;

-- ==================== [050_leads_score_check.sql] ====================
-- Concern: CONSTRAINTS. lead_score is a 0-100 normalized score; anything
-- outside is a scoring bug and must not silently persist.
DO $$ BEGIN
  ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_score_range_chk;
  ALTER TABLE leads ADD CONSTRAINT leads_score_range_chk CHECK (lead_score BETWEEN 0 AND 100);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN check_violation THEN NULL; END $$;

-- ==================== [060_companies_name_not_blank.sql] ====================
-- companies.name is NOT NULL, which still admits ''. A blank name renders as an empty
-- cell and an empty edit form, and one row reached production that way. The rule lives
-- here rather than in app code so every writer is covered: the normalizer upsert, POST
-- /companies, and admin edits all hit the same constraint.
ALTER TABLE companies DROP CONSTRAINT IF EXISTS companies_name_not_blank;
ALTER TABLE companies
  ADD CONSTRAINT companies_name_not_blank CHECK (trim(name) <> '');
