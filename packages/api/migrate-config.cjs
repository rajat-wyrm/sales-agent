module.exports = {
  databaseUrl: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/leads_db',
  dir: process.env.MIGRATIONS_DIR || 'migrations',
  direction: 'up',
  migrationsTable: 'pgmigrations',
};
