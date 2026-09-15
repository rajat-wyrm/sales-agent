-- companies.name is NOT NULL, which still admits ''. A blank name renders as an empty
-- cell and an empty edit form, and one row reached production that way. The rule lives
-- here rather than in app code so every writer is covered: the normalizer upsert, POST
-- /companies, and admin edits all hit the same constraint.
ALTER TABLE companies DROP CONSTRAINT IF EXISTS companies_name_not_blank;
ALTER TABLE companies
  ADD CONSTRAINT companies_name_not_blank CHECK (trim(name) <> '');
