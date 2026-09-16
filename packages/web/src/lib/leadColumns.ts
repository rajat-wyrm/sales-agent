/**
 * Browser-side mirror of packages/api/src/utils/leadColumns.ts.
 *
 * The API owns the column registry (it also builds the SQL SELECT and the workbook),
 * but this file is loaded by the UI, which must not pull in node's crypto or the
 * server query text. The header order here is asserted equal to the API registry by
 * packages/api/test/leadColumns.test.ts, so the two cannot drift silently: adding a
 * field to one without the other fails CI.
 */

export interface LeadColumn {
  header: string;
  field: string;
  group: string;
  get: (r: any) => unknown;
}

const loc = (r: any) => [r.city, r.state, r.country].filter(Boolean).join(', ') || r.location || '';

export const LEAD_COLUMNS: LeadColumn[] = [
  { header: 'Score', field: 'lead_score', group: 'Identity', get: (r) => r.lead_score },
  { header: 'Band', field: 'score_band', group: 'Identity', get: (r) => r.score_band },
  { header: 'Lead ID', field: 'id', group: 'Identity', get: (r) => r.id },
  { header: 'Pipeline Stage', field: 'pipeline_stage', group: 'Identity', get: (r) => r.pipeline_stage },
  { header: 'Data Quality', field: 'data_quality', group: 'Identity', get: (r) => r.data_quality },
  { header: 'Assigned To', field: 'assigned_to_email', group: 'Identity', get: (r) => r.assigned_to_email || r.assigned_to || '' },
  { header: 'Do Not Contact', field: 'do_not_contact', group: 'Identity', get: (r) => (r.do_not_contact ? 'YES' : 'no') },
  { header: 'Possible Duplicate Of', field: 'possible_duplicate_of', group: 'Identity', get: (r) => r.possible_duplicate_of || '' },
  { header: 'Legal Basis', field: 'legal_basis', group: 'Identity', get: (r) => r.legal_basis },
  { header: 'Processing Purpose', field: 'processing_purpose', group: 'Identity', get: (r) => r.processing_purpose },

  { header: 'Job Title', field: 'job_title', group: 'Job posting', get: (r) => r.job_title },
  { header: 'Source', field: 'source_site', group: 'Job posting', get: (r) => r.source_site },
  { header: 'Department', field: 'department', group: 'Job posting', get: (r) => r.department },
  { header: 'Openings', field: 'openings_count', group: 'Job posting', get: (r) => r.openings_count },
  { header: 'Experience', field: 'experience_level', group: 'Job posting', get: (r) => r.experience_level },
  { header: 'Job URL', field: 'job_url', group: 'Job posting', get: (r) => r.job_url },
  { header: 'Apply URL', field: 'apply_url', group: 'Job posting', get: (r) => r.apply_url },
  { header: 'Job Description', field: 'job_description', group: 'Job posting', get: (r) => r.job_description },
  { header: 'About Job', field: 'about_job', group: 'Job posting', get: (r) => r.about_job },

  { header: 'Location', field: 'location', group: 'Location & terms', get: loc },
  { header: 'City', field: 'city', group: 'Location & terms', get: (r) => r.city },
  { header: 'State', field: 'state', group: 'Location & terms', get: (r) => r.state },
  { header: 'Country', field: 'country', group: 'Location & terms', get: (r) => r.country },
  { header: 'Location Type', field: 'location_type', group: 'Location & terms', get: (r) => r.location_type || (r.is_work_from_home ? 'remote' : '') },
  { header: 'Employment Type', field: 'employment_type', group: 'Location & terms', get: (r) => r.employment_type },

  { header: 'Salary Range', field: 'salary_range', group: 'Compensation', get: (r) => r.salary_range },
  { header: 'Salary Min', field: 'salary_min', group: 'Compensation', get: (r) => r.salary_min },
  { header: 'Salary Max', field: 'salary_max', group: 'Compensation', get: (r) => r.salary_max },
  { header: 'Currency', field: 'salary_currency', group: 'Compensation', get: (r) => r.salary_currency },
  { header: 'Salary Period', field: 'salary_period', group: 'Compensation', get: (r) => r.salary_period },

  { header: 'HR Name', field: 'hr_name', group: 'HR contact', get: (r) => r.hr_name },
  { header: 'HR Email', field: 'hr_email', group: 'HR contact', get: (r) => r.hr_email },
  { header: 'HR Mobile', field: 'hr_mobile', group: 'HR contact', get: (r) => r.hr_mobile },
  { header: 'HR LinkedIn', field: 'hr_linkedin_url', group: 'HR contact', get: (r) => r.hr_linkedin_url },
  { header: 'Email Status', field: 'email_status', group: 'HR contact', get: (r) => r.email_status },
  { header: 'WhatsApp Status', field: 'whatsapp_status', group: 'HR contact', get: (r) => r.whatsapp_status },
  { header: 'HR Confidence', field: 'hr_confidence', group: 'HR contact', get: (r) => r.hr_confidence },
  { header: 'Contact Source', field: 'contact_source', group: 'HR contact', get: (r) => r.contact_source },
  { header: 'Contact Method', field: 'contact_method', group: 'HR contact', get: (r) => r.contact_method },
  { header: 'Contact Found At', field: 'contact_url', group: 'HR contact', get: (r) => r.contact_url },

  { header: 'Company', field: 'company_name', group: 'Company', get: (r) => r.company_name },
  { header: 'Domain', field: 'company_domain', group: 'Company', get: (r) => r.company_domain },
  { header: 'Industry', field: 'industry', group: 'Company', get: (r) => r.industry },
  { header: 'Company Size', field: 'size_estimate', group: 'Company', get: (r) => r.size_estimate },
  { header: 'Website', field: 'website_url', group: 'Company', get: (r) => r.website_url },
  { header: 'Company Email', field: 'default_email', group: 'Company', get: (r) => r.default_email },
  { header: 'Company Phone', field: 'default_phone', group: 'Company', get: (r) => r.default_phone },
  { header: 'About Company', field: 'about_company', group: 'Company', get: (r) => r.about_company },

  { header: 'Posted', field: 'posted_at', group: 'Timestamps', get: (r) => r.posted_at },
  { header: 'Discovered', field: 'created_at', group: 'Timestamps', get: (r) => r.created_at },
  { header: 'Updated', field: 'updated_at', group: 'Timestamps', get: (r) => r.updated_at },
];

// Mirrors the API's guardFormula(): a value starting with = + - @ | is executed by
// spreadsheet software, so scraped/imported text gets an apostrophe first.
const FORMULA_OPENERS = /^[-+=@|\t\r\n]/;
const guardFormula = (s: string) => (FORMULA_OPENERS.test(s) ? `'${s}` : s);

const csvCell = (v: unknown) => {
  if (v === null || v === undefined) return '';
  // Keep one line per lead; see the API registry for why.
  const s = String(v).replace(/\r?\n/g, ' ');
  return `"${guardFormula(s).replace(/"/g, '""')}"`;
};

/** CSV built from the same registry the workbook uses. */
export function leadsToCsv(rows: any[]): string {
  return '\ufeff' + [
    LEAD_COLUMNS.map((c) => `"${c.header}"`).join(','),
    ...rows.map((r) => LEAD_COLUMNS.map((c) => csvCell(c.get(r))).join(',')),
  ].join('\r\n');
}

// ---------------------------------------------------------------------------
// Import parsing (preview only; the server re-maps headers authoritatively)
// ---------------------------------------------------------------------------

export function parseDelimited(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const nl = src.indexOf('\n');
  const firstLine = nl === -1 ? src : src.slice(0, nl);
  const delim = (firstLine.match(/\t/g) || []).length > (firstLine.match(/,/g) || []).length ? '\t' : ',';

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else { quoted = false; }
      } else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === delim) { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }

  const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
  return rows
    .filter((r) => r.some((c) => c.trim() !== ''))
    .map((r) => (r.length === width ? r : [...r, ...Array(width - r.length).fill('')]));
}

const ALIASES: Record<string, string[]> = {
  company_name: ['company_name', 'company', 'organization', 'employer', 'account name', 'company name', 'client'],
  company_domain: ['company_domain', 'domain', 'company domain', 'website domain'],
  website_url: ['website_url', 'website', 'company website', 'url'],
  industry: ['industry', 'sector'],
  size_estimate: ['size_estimate', 'company size', 'employees', 'headcount'],
  default_email: ['default_email', 'company email', 'official email'],
  default_phone: ['default_phone', 'company phone', 'company mobile', 'office phone'],
  job_title: ['job_title', 'title', 'role', 'job title', 'position', 'designation', 'job role'],
  job_url: ['job_url', 'job url', 'job link', 'posting url', 'vacancy url', 'url of job'],
  apply_url: ['apply_url', 'apply url', 'apply link', 'application url'],
  source_site: ['source_site', 'source', 'source site', 'job board', 'portal', 'channel'],
  department: ['department', 'team', 'function'],
  openings_count: ['openings_count', 'openings', 'vacancies', 'positions available'],
  experience_level: ['experience_level', 'experience', 'experience required', 'years of experience', 'exp'],
  employment_type: ['employment_type', 'employment type', 'job type', 'type of employment'],
  location_type: ['location_type', 'work mode', 'workplace', 'remote', 'hybrid'],
  is_work_from_home: ['is_work_from_home', 'work from home', 'wfh'],
  location: ['location', 'job location', 'work location'],
  city: ['city', 'location city'],
  state: ['state', 'region', 'province'],
  country: ['country'],
  salary_range: ['salary_range', 'salary', 'ctc', 'compensation', 'salary range', 'pay'],
  salary_min: ['salary_min', 'min salary', 'salary min', 'minimum salary', 'ctc min'],
  salary_max: ['salary_max', 'max salary', 'salary max', 'maximum salary', 'ctc max'],
  salary_currency: ['salary_currency', 'currency'],
  salary_period: ['salary_period', 'period', 'salary period'],
  job_description: ['job_description', 'description', 'job description', 'jd'],
  about_job: ['about_job', 'about job', 'job summary'],
  hr_name: ['hr_name', 'contact name', 'name', 'full name', 'hr contact', 'hr name', 'recruiter', 'hiring manager'],
  hr_email: ['hr_email', 'email', 'email address', 'hr email', 'personal email', 'e mail', 'contact email'],
  hr_mobile: ['hr_mobile', 'mobile', 'phone', 'contact number', 'phone number', 'hr mobile', 'whatsapp', 'mobile number'],
  hr_linkedin_url: ['hr_linkedin_url', 'linkedin', 'linkedin url', 'hr linkedin', 'profile', 'linkedin profile'],
  pipeline_stage: ['pipeline_stage', 'stage', 'status'],
  score_band: ['score_band', 'band'],
  lead_score: ['lead_score', 'score', 'lead score'],
  notes: ['notes', 'note', 'comments', 'remark', 'remarks'],
};

const slugHeader = (h: string) => h.toLowerCase().replace(/^\ufeff/, '').replace(/[\s_\-]+/g, ' ').replace(/[.:]+$/g, '').trim();

export function matchHeader(header: string): string | null {
  const h = slugHeader(header);
  if (!h) return null;
  for (const [field, aliases] of Object.entries(ALIASES)) {
    if (slugHeader(field) === h || aliases.some((a) => slugHeader(a) === h)) return field;
  }
  for (const [field, aliases] of Object.entries(ALIASES)) {
    if (aliases.some((a) => { const s = slugHeader(a); return s.length > 3 && (h.includes(s) || s.includes(h)); })) return field;
  }
  return null;
}

export const IMPORT_MINIMUM_FIELDS = ['company_name', 'job_title', 'job_url', 'hr_name', 'hr_email'];

export interface ParsedImport {
  records: Array<Record<string, string>>;
  mapped: Record<string, string>;
  unmapped: string[];
}

export function normaliseLeadRecords(table: string[][]): ParsedImport {
  const headerRow = table[0] ?? [];
  const mapped: Record<string, string> = {};
  const unmapped: string[] = [];
  const indexes: Array<{ col: number; field: string }> = [];

  headerRow.forEach((raw, col) => {
    const field = matchHeader(raw);
    if (!field) { if (raw.trim()) unmapped.push(raw.trim()); return; }
    if (mapped[field]) return;
    mapped[field] = raw.trim();
    indexes.push({ col, field });
  });

  const records = table.slice(1).map((row) => {
    const rec: Record<string, string> = {};
    for (const { col, field } of indexes) {
      const v = (row[col] ?? '').trim();
      rec[field] = v.startsWith("'") ? v.slice(1) : v;
    }
    return rec;
  }).filter((rec) => IMPORT_MINIMUM_FIELDS.some((f) => (rec[f] ?? '') !== ''));

  return { records, mapped, unmapped };
}
