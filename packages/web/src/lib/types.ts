export interface Company {
  id: string;
  name: string;
  domain: string | null;
  about: string | null;
  industry: string | null;
  size_estimate: string | null;
  default_email: string | null;
  default_phone: string | null;
  website_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface HRContact {
  id: string;
  full_name: string | null;
  linkedin_url: string | null;
  personal_email: string | null;
  personal_mobile: string | null;
  current_company_id: string | null;
  confidence_score: number;
  created_at: string;
  updated_at: string;
}

export type PipelineStage =
  | 'discovered'
  | 'enriched'
  | 'verified'
  | 'drafted'
  | 'contacted'
  | 'replied'
  | 'bounced'
  | 'contact_unavailable'
  | 'suppressed'
  | 'send_failed'
  | 'provider_error'
  | 'retry_pending';

export type ScoreBand = 'hot' | 'warm' | 'cold';
export type DataQuality = 'complete' | 'incomplete';
export type EmailStatus = 'valid' | 'invalid' | 'catch_all' | 'disposable' | 'unknown' | 'expired' | null;
export type WhatsAppStatus = 'registered' | 'not_registered' | 'unknown' | 'expired' | null;

export interface Lead {
  id: string;
  job_posting_id: string;
  company_id: string;
  hr_contact_id: string | null;
  lead_score: number;
  score_band: ScoreBand;
  pipeline_stage: PipelineStage;
  data_quality: DataQuality;
  email_status: EmailStatus;
  whatsapp_status: WhatsAppStatus;
  do_not_contact: boolean;
  possible_duplicate_of: string | null;
  assigned_to: string | null;
  created_at: string;
  updated_at: string;
  hr_extraction_provenance?: any;
  enrichment_provenance?: any;

  company_name: string;
  company_domain: string | null;
  job_title: string | null;
  hr_name: string | null;
  hr_linkedin_url: string | null;
  hr_email: string | null;
  hr_mobile: string | null;
  source_site: string | null;
  confidence_score?: number;
  contact_source?: string;
  contact_method?: string;
  contact_url?: string;
  job_description: string | null;
  experience_level: string | null;
  salary_range: string | null;
  job_url: string | null;

  // Posting facets. The API now returns these; they were absent from the model,
  // so the UI had no way to show where a job is, what it pays, or when it was
  // posted even though the scraper had captured some of it.
  location?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  location_type?: 'remote' | 'onsite' | 'hybrid' | null;
  employment_type?: string | null;
  is_work_from_home?: boolean | null;
  apply_url?: string | null;
  posted_at?: string | null;
  about_job?: string | null;
  department?: string | null;
  openings_count?: number | null;
  salary_min?: number | string | null;
  salary_max?: number | string | null;
  salary_currency?: string | null;
  salary_period?: string | null;
}

export interface LeadDetail extends Lead {
  about_company: string | null;
  about_job: string | null;
  industry: string | null;
  size_estimate: string | null;
  website_url: string | null;
  default_email: string | null;
  default_phone: string | null;
  legal_basis: string | null;
  processing_purpose: string | null;
  possible_duplicate_of: string | null;
  job_posting_id: string | null;
  company_id: string | null;
  hr_contact_id: string | null;
  hr_confidence: number | null;
  domain: string | null;
  hr_extraction_provenance?: any;
  enrichment_log: EnrichmentLog[];
  verification_log: VerificationLog[];
  drafts: OutreachDraft[];
  outreach_log: OutreachLog[];
}


export interface EnrichmentLog {
  id: string;
  lead_id: string;
  provider: string;
  requested_by: string | null;
  request_payload: any;
  response_payload: any;
  credits_used: number;
  status: 'success' | 'failed' | 'no_match';
  created_at: string;
}

export interface VerificationLog {
  id: string;
  lead_id: string;
  channel: 'email' | 'whatsapp';
  result: string;
  raw_response: any;
  created_at: string;
}

export interface OutreachDraft {
  id: string;
  lead_id: string;
  channel: 'email' | 'whatsapp';
  version: number;
  subject: string | null;
  body: string;
  generated_by: string;
  is_edited: boolean;
  created_at: string;
}

export interface OutreachLog {
  id: string;
  lead_id: string;
  draft_id: string | null;
  channel: 'email' | 'whatsapp';
  sent_by: string | null;
  provider_message_id: string | null;
  delivery_status: 'sent' | 'delivered' | 'bounced' | 'replied' | 'failed';
  sent_at: string;
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  pages: number;
}

export interface User {
  id: string;
  email: string;
  role: 'admin' | 'sales_rep' | 'viewer';
}

export interface LoginResponse {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
  user: { id: string; email: string; role: string };
}
