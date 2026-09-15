import { ColumnType, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: Record<string, ColumnType> | undefined = undefined;

/**
 * companies.name is NOT NULL, which still admits '' -- one row slipped through and
 * rendered as a blank cell with an empty edit form. A CHECK on the trimmed value is
 * the smallest rule that makes it impossible, and lives in the DB so every writer
 * (normalizer upsert, API create, admin edit) is covered at once.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  // Repair before constraining, or adding the CHECK fails on the existing row.
  await pgm.db.query(`
    UPDATE companies SET name = domain
     WHERE trim(coalesce(name, '')) = '' AND trim(coalesce(domain, '')) <> ''
  `);
  await pgm.db.query(`
    DELETE FROM companies
     WHERE trim(coalesce(name, '')) = '' AND trim(coalesce(domain, '')) = ''
  `);
  await pgm.db.query(`
    ALTER TABLE companies
      ADD CONSTRAINT companies_name_not_blank CHECK (trim(name) <> '')
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  await pgm.db.query(`ALTER TABLE companies DROP CONSTRAINT companies_name_not_blank`);
}
