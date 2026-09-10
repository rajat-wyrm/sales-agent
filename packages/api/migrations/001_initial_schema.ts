import type { MigrationContext } from 'node-pg-migrate';

export const up = (pgm: MigrationContext) => {
  pgm.createExtension('uuid-ossp', { ifNotExists: true });
  pgm.createExtension('pgcrypto', { ifNotExists: true });

  pgm.createTable('users', {
    id: { type: 'UUID', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    email: { type: 'TEXT', unique: true, notNull: true },
    password_hash: { type: 'TEXT', notNull: true },
    role: { type: 'TEXT', default: "'sales_rep'" },
    api_keys: { type: 'JSONB' },
    created_at: { type: 'TIMESTAMPTZ', default: pgm.func('NOW()') },
    updated_at: { type: 'TIMESTAMPTZ', default: pgm.func('NOW()') },
  });
  pgm.addConstraint('users', 'users_role_check', {
    check: "role IN ('admin', 'sales_rep', 'viewer')",
  });

  pgm.createTable('companies', {
    id: { type: 'UUID', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    name: { type: 'TEXT', notNull: true },
    domain: { type: 'TEXT' },
    about: { type: 'TEXT' },
    industry: { type: 'TEXT' },
    size_estimate: { type: 'TEXT' },
    default_email: { type: 'TEXT' },
    default_phone: { type: 'TEXT' },
    website_url: { type: 'TEXT' },
    created_at: { type: 'TIMESTAMPTZ', default: pgm.func('NOW()') },
    updated_at: { type: 'TIMESTAMPTZ', default: pgm.func('NOW()') },
  });
  pgm.createIndex('companies', 'domain', { unique: true, where: 'domain IS NOT NULL' });

  pgm.createTable('hr_contacts', {
    id: { type: 'UUID', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    full_name: { type: 'TEXT' },
    linkedin_url: { type: 'TEXT', unique: true },
    personal_email: { type: 'TEXT' },
    personal_mobile: { type: 'TEXT' },
    current_company_id: { type: 'UUID', references: 'companies(id)', onDelete: 'SET NULL' },
    confidence_score: { type: 'SMALLINT', default: 0 },
    created_at: { type: 'TIMESTAMPTZ', default: pgm.func('NOW()') },
    updated_at: { type: 'TIMESTAMPTZ', default: pgm.func('NOW()') },
  });

  pgm.createTable('job_postings', {
    id: { type: 'UUID', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    company_id: { type: 'UUID', notNull: true, references: 'companies(id)', onDelete: 'CASCADE' },
    hr_contact_id: { type: 'UUID', references: 'hr_contacts(id)', onDelete: 'SET NULL' },
    title: { type: 'TEXT', notNull: true },
    description: { type: 'TEXT' },
    experience_level: { type: 'TEXT' },
    salary_range: { type: 'TEXT' },
    job_url: { type: 'TEXT', notNull: true },
    source_site: { type: 'TEXT', notNull: true },
    fingerprint: { type: 'TEXT', notNull: true },
    raw_payload: { type: 'JSONB' },
    first_seen_at: { type: 'TIMESTAMPTZ', default: pgm.func('NOW()') },
    last_seen_at: { type: 'TIMESTAMPTZ', default: pgm.func('NOW()') },
    is_active: { type: 'BOOLEAN', default: true },
  });
  pgm.createIndex('job_postings', 'fingerprint', { unique: true });
  pgm.createIndex('job_postings', 'is_active');
  pgm.createIndex('job_postings', 'last_seen_at');

  pgm.createTable('leads', {
    id: { type: 'UUID', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    job_posting_id: { type: 'UUID', notNull: true, unique: true, references: 'job_postings(id)', onDelete: 'CASCADE' },
    company_id: { type: 'UUID', notNull: true, references: 'companies(id)', onDelete: 'CASCADE' },
    hr_contact_id: { type: 'UUID', references: 'hr_contacts(id)', onDelete: 'SET NULL' },
    lead_score: { type: 'SMALLINT', default: 0 },
    score_band: { type: 'TEXT', default: "'cold'" },
    pipeline_stage: { type: 'TEXT', default: "'discovered'" },
    data_quality: { type: 'TEXT', default: "'complete'" },
    email_status: { type: 'TEXT' },
    whatsapp_status: { type: 'TEXT' },
    possible_duplicate_of: { type: 'UUID', references: 'leads(id)', onDelete: 'SET NULL' },
    assigned_to: { type: 'UUID', references: 'users(id)', onDelete: 'SET NULL' },
    created_at: { type: 'TIMESTAMPTZ', default: pgm.func('NOW()') },
    updated_at: { type: 'TIMESTAMPTZ', default: pgm.func('NOW()') },
  });
  pgm.createIndex('leads', 'lead_score');
  pgm.createIndex('leads', 'pipeline_stage');
  pgm.createIndex('leads', 'created_at');

  pgm.createTable('enrichment_log', {
    id: { type: 'UUID', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    lead_id: { type: 'UUID', notNull: true, references: 'leads(id)', onDelete: 'CASCADE' },
    provider: { type: 'TEXT', notNull: true },
    requested_by: { type: 'UUID', references: 'users(id)', onDelete: 'SET NULL' },
    request_payload: { type: 'JSONB' },
    response_payload: { type: 'JSONB' },
    credits_used: { type: 'INT', default: 1 },
    status: { type: 'TEXT' },
    created_at: { type: 'TIMESTAMPTZ', default: pgm.func('NOW()') },
  });

  pgm.createTable('verification_log', {
    id: { type: 'UUID', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    lead_id: { type: 'UUID', notNull: true, references: 'leads(id)', onDelete: 'CASCADE' },
    channel: { type: 'TEXT', notNull: true },
    result: { type: 'TEXT', notNull: true },
    raw_response: { type: 'JSONB' },
    created_at: { type: 'TIMESTAMPTZ', default: pgm.func('NOW()') },
  });

  pgm.createTable('outreach_drafts', {
    id: { type: 'UUID', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    lead_id: { type: 'UUID', notNull: true, references: 'leads(id)', onDelete: 'CASCADE' },
    channel: { type: 'TEXT', notNull: true },
    version: { type: 'INT', notNull: true, default: 1 },
    subject: { type: 'TEXT' },
    body: { type: 'TEXT', notNull: true },
    generated_by: { type: 'TEXT', default: "'gemini-2.5-flash'" },
    is_edited: { type: 'BOOLEAN', default: false },
    created_at: { type: 'TIMESTAMPTZ', default: pgm.func('NOW()') },
  });
  pgm.createIndex('outreach_drafts', 'lead_id');

  pgm.createTable('outreach_log', {
    id: { type: 'UUID', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    lead_id: { type: 'UUID', notNull: true, references: 'leads(id)', onDelete: 'CASCADE' },
    draft_id: { type: 'UUID', references: 'outreach_drafts(id)', onDelete: 'SET NULL' },
    channel: { type: 'TEXT', notNull: true },
    sent_by: { type: 'UUID', references: 'users(id)', onDelete: 'SET NULL' },
    provider_message_id: { type: 'TEXT' },
    delivery_status: { type: 'TEXT', default: "'sent'" },
    sent_at: { type: 'TIMESTAMPTZ', default: pgm.func('NOW()') },
  });
  pgm.createIndex('outreach_log', 'lead_id');

  pgm.createTable('scrape_runs', {
    id: { type: 'UUID', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    started_at: { type: 'TIMESTAMPTZ', default: pgm.func('NOW()') },
    finished_at: { type: 'TIMESTAMPTZ' },
    sources_attempted: { type: 'INT' },
    sources_succeeded: { type: 'INT' },
    sources_circuit_broken: { type: 'TEXT[]' },
    leads_found: { type: 'INT' },
    leads_deduped: { type: 'INT' },
    errors: { type: 'JSONB' },
  });

  pgm.createTable('source_health', {
    source_name: { type: 'TEXT', primaryKey: true },
    consecutive_failures: { type: 'INT', default: 0 },
    circuit_open_until: { type: 'TIMESTAMPTZ' },
    last_success_at: { type: 'TIMESTAMPTZ' },
    last_failure_reason: { type: 'TEXT' },
  });

  pgm.createTable('audit_log', {
    id: { type: 'UUID', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    user_id: { type: 'UUID', references: 'users(id)', onDelete: 'SET NULL' },
    action: { type: 'TEXT', notNull: true },
    resource_type: { type: 'TEXT' },
    resource_id: { type: 'UUID' },
    details: { type: 'JSONB' },
    created_at: { type: 'TIMESTAMPTZ', default: pgm.func('NOW()') },
  });
  pgm.createIndex('audit_log', 'user_id');
  pgm.createIndex('audit_log', 'created_at');
};

export const down = (pgm: MigrationContext) => {
  pgm.dropTable('audit_log');
  pgm.dropTable('source_health');
  pgm.dropTable('scrape_runs');
  pgm.dropTable('outreach_log');
  pgm.dropTable('outreach_drafts');
  pgm.dropTable('verification_log');
  pgm.dropTable('enrichment_log');
  pgm.dropTable('leads');
  pgm.dropTable('job_postings');
  pgm.dropTable('hr_contacts');
  pgm.dropTable('companies');
  pgm.dropTable('users');
  pgm.dropExtension('pgcrypto');
  pgm.dropExtension('uuid-ossp');
};
