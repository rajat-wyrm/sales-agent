-- companies.domain is UNIQUE but companies.name was not, so a CSV import could create
-- "Acme" twice and every later lookup ("SELECT id FROM companies WHERE name = $1")
-- then picked one at random. The import's ON CONFLICT (lower(name)) needs this index
-- to exist; it also stops the scrapers inserting case-variant duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS companies_name_lower_key ON companies (lower(name));

-- The CSV importer's near-duplicate probe compares normalized company name + trigram
-- similarity of the title, so it needs pg_trgm and an index on the company key. Without
-- the index every imported row would sequential-scan companies/job_postings.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_companies_name_alnum ON companies (lower(regexp_replace(name, '[^a-zA-Z0-9]', '', 'g')));
CREATE INDEX IF NOT EXISTS idx_jobpostings_title_trgm_sim ON job_postings USING gin (title gin_trgm_ops);
