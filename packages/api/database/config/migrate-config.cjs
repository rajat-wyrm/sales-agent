// node-pg-migrate runner config. Applies the forward-only deltas in ../migrations
// (layered on top of the declarative ../schema). Run from the packages/api dir.
// v9 format: keys are CLI-style option names (see node-pg-migrate/bin --help).
// The `up`/`down` direction now comes from the CLI action, not a config key.
module.exports = {
  url: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/leads_db',
  'migrations-table': 'pgmigrations',
};
