-- triggers/triggers.sql — single source of truth for TRIGGERS (fresh-install schema).
-- Sections below are the former split files, kept in dependency order.
-- Idempotent: safe to re-run on every boot. Deployed-DB deltas live in database/migrations/.

-- ==================== [010_updated_at.sql] ====================
-- Concern: TRIGGERS.
-- Attach set_updated_at() to every table that carries an updated_at column so
-- the freshness timestamp is always current. DROP-then-CREATE keeps idempotent.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['companies','hr_contacts','users','leads','enrichment_jobs','settings']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_updated_at ON %1$I', t);
    EXECUTE format(
      'CREATE TRIGGER trg_%1$s_updated_at BEFORE UPDATE ON %1$I FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
      t
    );
  END LOOP;
END $$;

-- ==================== [020_audit_immutability.sql] ====================
-- Concern: TRIGGERS (data-integrity / compliance).
-- The audit trail must be append-only so it is trustworthy evidence for
-- compliance review. Any UPDATE or DELETE on audit_log is rejected at the
-- storage layer (independent of app logic). INSERT and SELECT are unaffected,
-- so normal logging + the admin audit viewer keep working.
CREATE OR REPLACE FUNCTION forbid_audit_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  DROP TRIGGER IF EXISTS trg_audit_log_immutable ON audit_log;
  CREATE TRIGGER trg_audit_log_immutable
    BEFORE UPDATE OR DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION forbid_audit_mutation();
END $$;

-- ==================== [025_audit_no_truncate.sql] ====================
-- Concern: TRIGGERS (compliance evidence integrity).
-- Complement to the row-level UPDATE/DELETE guard: the BEFORE UPDATE/DELETE row
-- trigger does NOT fire on TRUNCATE, so block that at the statement level too.
-- (True tamper-evidence ALSO requires the app connect as a non-owner role with
-- only INSERT/SELECT on audit_log — that's a deployment concern, see README.)
CREATE OR REPLACE FUNCTION forbid_audit_truncate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: TRUNCATE is not permitted';
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  DROP TRIGGER IF EXISTS trg_audit_log_no_truncate ON audit_log;
  CREATE TRIGGER trg_audit_log_no_truncate
    BEFORE TRUNCATE ON audit_log
    FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_truncate();
END $$;

-- ==================== [030_leads_stage_transition.sql] ====================
-- Attach the lifecycle guard (function lives in schema/functions/).
DO $$ BEGIN
  DROP TRIGGER IF EXISTS trg_leads_stage_transition ON leads;
  CREATE TRIGGER trg_leads_stage_transition
    BEFORE UPDATE OF pipeline_stage ON leads
    FOR EACH ROW EXECUTE FUNCTION enforce_leads_stage_transition();
END $$;
