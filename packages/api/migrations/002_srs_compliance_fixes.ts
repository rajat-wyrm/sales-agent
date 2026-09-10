import { MigrationBuilder, PgDatabase } from 'node-pg-migrate/names';

export const up = (pgm: MigrationBuilder) => {
  // Fix score_band: use GENERATED ALWAYS AS per SRS §10
  // NOTE: column ordering matters — do_not_contact must be added BEFORE
  // score_band is re-added, so it appears before score_band in the table schema
  // (matching manual_schema.sql ordering).
  pgm.sql(`
    ALTER TABLE leads 
    DROP COLUMN IF EXISTS score_band,
    ADD COLUMN IF NOT EXISTS do_not_contact BOOLEAN DEFAULT false
  `);

  // Match SRS §10: generated_by default = 'gemini-2.0-flash' (SRS §3.10 says "Gemini 2.0 Flash")
  pgm.sql(`
    ALTER TABLE outreach_drafts 
    ALTER COLUMN generated_by SET DEFAULT 'gemini-2.0-flash'
  `);

  // Re-add score_band as a generated column AFTER do_not_contact
  // so the column ordering matches the canonical schema
  pgm.sql(`
    ALTER TABLE leads 
    ADD COLUMN score_band TEXT GENERATED ALWAYS AS (
      CASE WHEN lead_score >= 70 THEN 'hot'
           WHEN lead_score >= 40 THEN 'warm'
           ELSE 'cold' END
    ) STORED
  `);

  // Add updated_at to users table per SRS §10
  pgm.sql(`
    ALTER TABLE users 
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()
  `);

  // SRS §4.5: add missing hr_contacts provenance columns
  pgm.sql(`
    ALTER TABLE hr_contacts 
    ADD COLUMN IF NOT EXISTS contact_source TEXT
  `);
  pgm.sql(`
    ALTER TABLE hr_contacts 
    ADD COLUMN IF NOT EXISTS contact_method TEXT
  `);
  pgm.sql(`
    ALTER TABLE hr_contacts 
    ADD COLUMN IF NOT EXISTS contact_url TEXT
  `);
  pgm.sql(`
    ALTER TABLE hr_contacts 
    ADD COLUMN IF NOT EXISTS extraction_provenance JSONB
  `);

  // SRS §4.5: add hr_extraction_provenance to leads
  pgm.sql(`
    ALTER TABLE leads 
    ADD COLUMN IF NOT EXISTS hr_extraction_provenance JSONB
  `);

  // SRS §9: create settings table
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
      updated_at TIMESTAMPTZ DEFAULT now()
    )
  `);

  // Add index for scored_band lookups (SRS §10 scalability notes)
  pgm.createIndex('leads', 'score_band');
  pgm.createIndex('leads', 'do_not_contact');
};

export const down = (pgm: MigrationBuilder) => {
  pgm.dropIndex('leads', 'do_not_contact');
  pgm.dropIndex('leads', 'score_band');
  pgm.sql(`DROP TABLE IF EXISTS settings`);
  pgm.sql(`ALTER TABLE leads DROP COLUMN IF EXISTS hr_extraction_provenance`);
  pgm.sql(`ALTER TABLE hr_contacts DROP COLUMN IF EXISTS extraction_provenance`);
  pgm.sql(`ALTER TABLE hr_contacts DROP COLUMN IF EXISTS contact_url`);
  pgm.sql(`ALTER TABLE hr_contacts DROP COLUMN IF EXISTS contact_method`);
  pgm.sql(`ALTER TABLE hr_contacts DROP COLUMN IF EXISTS contact_source`);
  pgm.sql(`ALTER TABLE users DROP COLUMN IF EXISTS updated_at`);
  pgm.sql(`ALTER TABLE leads DROP COLUMN IF EXISTS do_not_contact`);
  pgm.sql(`ALTER TABLE leads DROP COLUMN IF EXISTS score_band`);
  pgm.sql(`ALTER TABLE leads ADD COLUMN score_band TEXT DEFAULT 'cold'`);
  pgm.sql(`ALTER TABLE outreach_drafts ALTER COLUMN generated_by SET DEFAULT 'gemini-2.0-flash'`);
};
