CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  domain TEXT UNIQUE,
  about TEXT,
  industry TEXT,
  size_estimate TEXT,
  default_email TEXT,
  default_phone TEXT,
  website_url TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS hr_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name TEXT,
  linkedin_url TEXT UNIQUE,
  personal_email TEXT,
  personal_mobile TEXT,
  current_company_id UUID REFERENCES companies(id) ON DELETE SET NULL,
  confidence_score SMALLINT DEFAULT 0,
  contact_source TEXT,                    -- direct_extracted | search_discovered | osint_discovered | whois_discovered | provider_enriched | pattern_generated
  contact_method TEXT,                   -- how the contact was found (e.g., career_page_regex, ddg_dork, whois)
  contact_url TEXT,                      -- URL where the contact was found
  extraction_provenance JSONB,           -- full audit trail of extraction stages
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT DEFAULT 'sales_rep',
  api_keys JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS job_postings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID REFERENCES companies(id) ON DELETE CASCADE NOT NULL,
  hr_contact_id UUID REFERENCES hr_contacts(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT,
  experience_level TEXT,
  salary_range TEXT,
  job_url TEXT NOT NULL,
  source_site TEXT NOT NULL,
  fingerprint TEXT NOT NULL UNIQUE,
  raw_payload JSONB,
  first_seen_at TIMESTAMPTZ DEFAULT now(),
  last_seen_at TIMESTAMPTZ DEFAULT now(),
  is_active BOOLEAN DEFAULT true
);

CREATE INDEX IF NOT EXISTS idx_jobposting_active ON job_postings(is_active, last_seen_at);
CREATE INDEX IF NOT EXISTS idx_jobposting_fingerprint ON job_postings(fingerprint);

CREATE TABLE IF NOT EXISTS leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_posting_id UUID UNIQUE REFERENCES job_postings(id) ON DELETE CASCADE NOT NULL,
  company_id UUID REFERENCES companies(id) ON DELETE CASCADE NOT NULL,
  hr_contact_id UUID REFERENCES hr_contacts(id) ON DELETE SET NULL,
  lead_score SMALLINT DEFAULT 0,
  score_band TEXT GENERATED ALWAYS AS (
    CASE WHEN lead_score >= 70 THEN 'hot'
         WHEN lead_score >= 40 THEN 'warm'
         ELSE 'cold' END
  ) STORED,
  pipeline_stage TEXT DEFAULT 'discovered',
  data_quality TEXT DEFAULT 'complete',
  email_status TEXT,
  whatsapp_status TEXT,
  do_not_contact BOOLEAN DEFAULT false,
  possible_duplicate_of UUID REFERENCES leads(id) ON DELETE SET NULL,
  assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
  hr_extraction_provenance JSONB,            -- SRS §4.5 provenance audit trail
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_leads_score ON leads(lead_score DESC);
CREATE INDEX IF NOT EXISTS idx_leads_stage ON leads(pipeline_stage);
CREATE INDEX IF NOT EXISTS idx_leads_created ON leads(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_leads_score_band ON leads(score_band);

CREATE TABLE IF NOT EXISTS enrichment_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID REFERENCES leads(id) ON DELETE CASCADE NOT NULL,
  provider TEXT NOT NULL,
  requested_by UUID REFERENCES users(id) ON DELETE SET NULL,
  request_payload JSONB,
  response_payload JSONB,
  credits_used INT DEFAULT 1,
  status TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS verification_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID REFERENCES leads(id) ON DELETE CASCADE NOT NULL,
  channel TEXT NOT NULL,
  result TEXT NOT NULL,
  raw_response JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS outreach_drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID REFERENCES leads(id) ON DELETE CASCADE NOT NULL,
  channel TEXT NOT NULL,
  version INT NOT NULL DEFAULT 1,
  subject TEXT,
  body TEXT NOT NULL,
  generated_by TEXT DEFAULT 'gemini-2.5-flash',
  is_edited BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS outreach_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID REFERENCES leads(id) ON DELETE CASCADE NOT NULL,
  draft_id UUID REFERENCES outreach_drafts(id) ON DELETE SET NULL,
  channel TEXT NOT NULL,
  sent_by UUID REFERENCES users(id) ON DELETE SET NULL,
  provider_message_id TEXT,
  delivery_status TEXT DEFAULT 'sent',
  sent_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_outreach_log_lead ON outreach_log(lead_id);

CREATE TABLE IF NOT EXISTS scrape_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at TIMESTAMPTZ DEFAULT now(),
  finished_at TIMESTAMPTZ,
  sources_attempted INT,
  sources_succeeded INT,
  sources_circuit_broken TEXT[],
  leads_found INT,
  leads_deduped INT,
  errors JSONB
);

CREATE TABLE IF NOT EXISTS source_health (
  source_name TEXT PRIMARY KEY,
  consecutive_failures INT DEFAULT 0,
  circuit_open_until TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_failure_reason TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  details JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);
