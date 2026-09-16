-- companies.domain is UNIQUE but companies.name was not, so a CSV import could create
-- "Acme" twice and every later lookup ("SELECT id FROM companies WHERE name = $1")
-- then picked one at random. The import's ON CONFLICT (lower(name)) needs this index
-- to exist; it also stops the scrapers inserting case-variant duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS companies_name_lower_key ON companies (lower(name));
