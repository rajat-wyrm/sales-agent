import { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  await pgm.db.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS claimed_by UUID REFERENCES users(id) ON DELETE SET NULL`);
  await pgm.db.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ`);
  await pgm.db.query(`CREATE INDEX IF NOT EXISTS idx_leads_claimed_by ON leads(claimed_by)`);
  await pgm.db.query(`CREATE INDEX IF NOT EXISTS idx_leads_claimed_created ON leads(claimed_by, created_at DESC)`);
  await pgm.db.query(`
    CREATE TABLE IF NOT EXISTS enrichment_jobs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      lead_id UUID REFERENCES leads(id) ON DELETE CASCADE NOT NULL,
      provider TEXT NOT NULL DEFAULT 'auto',
      status TEXT NOT NULL DEFAULT 'queued',
      current_stage TEXT NOT NULL DEFAULT 'queued',
      attempts SMALLINT NOT NULL DEFAULT 0,
      idempotency_key TEXT UNIQUE,
      requested_by UUID REFERENCES users(id) ON DELETE SET NULL,
      error JSONB,
      result_summary JSONB,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    )
  `);
  await pgm.db.query(`CREATE INDEX IF NOT EXISTS idx_enrichment_jobs_lead ON enrichment_jobs(lead_id, created_at DESC)`);
  await pgm.db.query(`CREATE INDEX IF NOT EXISTS idx_enrichment_jobs_status ON enrichment_jobs(status)`);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  await pgm.db.query(`DROP TABLE IF EXISTS enrichment_jobs`);
  await pgm.db.query(`ALTER TABLE leads DROP COLUMN IF EXISTS claimed_at`);
  await pgm.db.query(`ALTER TABLE leads DROP COLUMN IF EXISTS claimed_by`);
}
