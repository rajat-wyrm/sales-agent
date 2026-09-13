-- Concern: INDEXES (fuzzy search). The leads list `filter` runs ILIKE '%term%'
-- across company name/domain and job title. A plain btree can't serve a leading
-- wildcard; GIN + pg_trgm can. Requires the pg_trgm extension (schema/tables/000).
CREATE INDEX IF NOT EXISTS idx_companies_name_trgm ON companies USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_companies_domain_trgm ON companies USING gin (domain gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_jobposting_title_trgm ON job_postings USING gin (title gin_trgm_ops);
