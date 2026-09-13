CREATE TABLE IF NOT EXISTS hr_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name TEXT,
  linkedin_url TEXT UNIQUE,
  personal_email TEXT,
  personal_mobile TEXT,
  current_company_id UUID REFERENCES companies(id) ON DELETE SET NULL,
  confidence_score SMALLINT DEFAULT 0,
  contact_source TEXT,                    -- direct_extracted | search_discovered | osint_discovered | whois_discovered | provider_enriched | pattern_generated
  contact_method TEXT,                    -- how the contact was found (e.g., career_page_regex, ddg_dork, whois)
  contact_url TEXT,                       -- URL where the contact was found
  extraction_provenance JSONB,            -- full audit trail of extraction stages
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
