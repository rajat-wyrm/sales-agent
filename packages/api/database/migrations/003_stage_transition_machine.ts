import type { MigrationContext } from 'node-pg-migrate';
import * as fs from 'fs';
import * as path from 'path';

// Forward-only delta: lifecycle transition machine + legal-basis columns.
// Mirrors schema/functions.sql, schema/triggers.sql and tables.sql.
// Idempotent: safe to re-run.

function load(rel: string): string {
  return fs.readFileSync(path.join(__dirname, '..', 'schema', rel), 'utf8');
}

export const up = (pgm: MigrationContext) => {
  // Schema/ was consolidated from per-object files into one file per concern
  // (tables.sql / constraints.sql / functions.sql / triggers.sql / indexes.sql),
  // but this migration kept loading the old split paths. On any database where
  // 003 had not already been recorded, readFileSync threw ENOENT and the whole
  // migration run aborted -- so a fresh deploy could never reach 004+. The
  // consolidated files are strictly supersets and fully idempotent
  // (CREATE OR REPLACE + DROP TRIGGER IF EXISTS), so loading them replays the
  // stage-transition machine plus the harmless rest of the schema.
  pgm.sql(load('functions/functions.sql'));
  pgm.sql(load('triggers/triggers.sql'));
  pgm.sql(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS legal_basis TEXT DEFAULT 'legitimate_interest_b2b'`);
  pgm.sql(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS processing_purpose TEXT DEFAULT 'b2b_recruitment_outreach'`);
  pgm.sql(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS provenance JSONB`);
};

export const down = (pgm: MigrationContext) => {
  pgm.sql(`DROP TRIGGER IF EXISTS trg_leads_stage_transition ON leads`);
  pgm.sql(`DROP FUNCTION IF EXISTS enforce_leads_stage_transition()`);
  pgm.sql(`DROP FUNCTION IF EXISTS leads_stage_transition_ok(TEXT, TEXT)`);
  pgm.sql(`ALTER TABLE leads DROP COLUMN IF EXISTS provenance`);
  pgm.sql(`ALTER TABLE leads DROP COLUMN IF EXISTS processing_purpose`);
  pgm.sql(`ALTER TABLE leads DROP COLUMN IF EXISTS legal_basis`);
};
