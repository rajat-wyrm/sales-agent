// node-pg-migrate runner config. Applies the forward-only deltas in ../migrations
// (layered on top of the declarative ../schema). Run from the packages/api dir.
module.exports = {
  databaseUrl: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/leads_db',
  dir: process.env.MIGRATIONS_DIR || 'database/migrations',
  direction: 'up',
  migrationsTable: 'pgmigrations',
};
