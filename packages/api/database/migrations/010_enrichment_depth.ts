import { MigrationBuilder } from 'node-pg-migrate';

/**
 * Person + company enrichment depth: every high-yield field the providers
 * (Apollo/Lusha/RocketReach/OSINT) return now has a column to live in, plus
 * per-field provenance so merges stay explainable. All IF NOT EXISTS: fast
 * and safe to re-run.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  const personCols = [
    `job_title TEXT`,
    `department TEXT`,
    `seniority TEXT`,
    `location TEXT`,
    `emails JSONB NOT NULL DEFAULT '[]'`,
    `phones JSONB NOT NULL DEFAULT '[]'`,
    `email_verified BOOLEAN NOT NULL DEFAULT false`,
    `socials JSONB NOT NULL DEFAULT '{}'`,
    `field_provenance JSONB NOT NULL DEFAULT '{}'`,
  ];
  for (const col of personCols) {
    await pgm.db.query(`ALTER TABLE hr_contacts ADD COLUMN IF NOT EXISTS ${col}`);
  }
  const companyCols = [
    `employee_count INT`,
    `revenue TEXT`,
    `founded_year SMALLINT`,
    `tech_stack JSONB NOT NULL DEFAULT '[]'`,
    `linkedin_url TEXT`,
    `twitter_url TEXT`,
    `city TEXT`,
    `country TEXT`,
    `field_provenance JSONB NOT NULL DEFAULT '{}'`,
  ];
  for (const col of companyCols) {
    await pgm.db.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS ${col}`);
  }
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  for (const t of ['hr_contacts', 'companies']) {
    await pgm.db.query(`ALTER TABLE ${t} DROP COLUMN IF EXISTS field_provenance`);
  }
  for (const c of ['job_title', 'department', 'seniority', 'location', 'emails', 'phones', 'email_verified', 'socials']) {
    await pgm.db.query(`ALTER TABLE hr_contacts DROP COLUMN IF EXISTS ${c}`);
  }
  for (const c of ['employee_count', 'revenue', 'founded_year', 'tech_stack', 'linkedin_url', 'twitter_url', 'city', 'country']) {
    await pgm.db.query(`ALTER TABLE companies DROP COLUMN IF EXISTS ${c}`);
  }
}
