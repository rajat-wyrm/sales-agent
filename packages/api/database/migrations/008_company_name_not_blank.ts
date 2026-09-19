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
  //    ALTER TABLE companies
  //      ADD CONSTRAINT companies_name_not_blank CHECK (trim(name) <> '')
  //    Guarded ADD: the consolidated declarative schema
  //    (schema/constraints/constraints.sql) now declares this same constraint,
  //    so on a schema-fresh DB it already exists and the unconditional ADD
  //    fails with 42710 during a fresh-DB replay of the whole chain.
  await pgm.db.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'companies_name_not_blank'
           AND conrelid = 'companies'::regclass
      ) THEN
        ALTER TABLE companies
          ADD CONSTRAINT companies_name_not_blank CHECK (trim(name) <> '');
      END IF;
    END $$;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  await pgm.db.query(`ALTER TABLE companies DROP CONSTRAINT IF EXISTS companies_name_not_blank`);
}
