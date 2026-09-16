import type postgres from 'postgres';
import {
  normaliseLeadRecords,
  parseDelimited,
  generateFingerprint,
  urlHostname,
  slugHeader,
  HEADER_ALIAS_WORDS as HEADER_WORDS,
} from './leadColumns';
import { calculateCandidateSimilarity } from './dedup';
import { recomputeLeadScore } from './scoring';

/**
 * CSV/TSV lead import with automatic dedup.
 *
 * A rep gets a spreadsheet from another agency and pastes it in; nothing about that
 * file should create a second copy of a lead we already work. The ladder below runs
 * cheapest first and mirrors SRS §4.6 (the same rules the scrapers' normalizer applies),
 * so an imported row and a scraped row converge on one lead:
 *
 *   1. exact job_postings.fingerprint      -> merge into the existing lead
 *   2. exact (company name/domain + job url) match, when no title/url was given to
 *      fingerprint                          -> merge
 *   3. fuzzy similarity >= 0.85 over the last 30 days of leads -> merge, flagged as a
 *      possible duplicate so the Duplicates page still shows it for a human
 *   4. otherwise insert company / contact / posting / lead
 *
 * "Merge" means fill-only-blank (COALESCE): an import never overwrites data a rep has
 * already enriched or corrected, it only adds what was missing.
 */

const FUZZY_THRESHOLD = 0.85;
const MAX_ROWS = 5000;

export interface ImportResult {
  total_rows: number;
  created: number;
  merged: number;
  merged_fuzzy: number;
  skipped: number;
  columns_mapped: Record<string, string>;
  columns_ignored: string[];
  errors: Array<{ row: number; reason: string }>;
}

/** Cell text from a spreadsheet is unbounded; Postgres columns are not. Cap free text and
 * identifiers separately so one 200KB paste cannot bloat every row it touches. */
const MAX_TEXT = 20000;
const MAX_SHORT = 512;

const clamp = (v: string | null, max: number): string | null =>
  (v === null || v.length <= max) ? v : v.slice(0, max);

const blankToNull = (v: unknown): string | null => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim().replace(/^'/, '');
  return s === '' ? null : s;
};

/** Long free-text field (description-like). */
const text = (v: unknown): string | null => clamp(blankToNull(v), MAX_TEXT);
/** Short identifier field (name / email / url / enum-like). */
const short = (v: unknown): string | null => clamp(blankToNull(v), MAX_SHORT);

const num = (v: unknown): number | null => {
  const s = blankToNull(v);
  if (s === null) return null;
  // "₹12,00,000" / "12 LPA" / "USD 90k" — keep digits and one separator only.
  const cleaned = s.replace(/[^0-9.\-]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
};

const bool = (v: unknown): boolean | null => {
  const s = (blankToNull(v) ?? '').toLowerCase();
  if (!s) return null;
  if (/^(y|yes|true|1|remote|wfh|work from home)$/.test(s)) return true;
  if (/^(n|no|false|0|onsite|hybrid)$/.test(s)) return false;
  return null;
};

/**
 * The CHECK'd enums on job_postings. Free text from a spreadsheet has to land inside them
 * or the whole row is rejected by the database, so anything unmapped becomes 'unspecified'
 * (the enum carves that value out for exactly this) rather than passing the raw text through.
 * Tables mirror scrapers/normalizer.py so an imported row and a scraped one agree.
 */
const LOCATION_TYPES = ['remote', 'onsite', 'hybrid', 'field', 'unspecified'];

const WORKPLACE_MAP: Record<string, string> = {
  remote: 'remote', workfromhome: 'remote', wfh: 'remote',
  onsite: 'onsite', office: 'onsite', field: 'field',
  hybrid: 'hybrid', flexible: 'hybrid',
};

const EMPLOYMENT_MAP: Record<string, string> = {
  fulltime: 'full_time', permanent: 'full_time', fulltimemployee: 'full_time',
  parttime: 'part_time',
  contract: 'contract', contractual: 'contract', contractor: 'contract',
  internship: 'internship', intern: 'internship',
  apprenticeship: 'apprenticeship', trainee: 'apprenticeship',
  freelance: 'freelance', freelancer: 'freelance',
  temporary: 'temporary', temp: 'temporary',
  unspecified: 'unspecified',
};

const keyOf = (v: unknown) => (blankToNull(v) ?? '').toLowerCase().replace(/[\s_.-]+/g, '');

/** job_postings.employment_type; unknown-but-present text degrades to 'unspecified'. */
export function employmentTypeOf(v: unknown): string | null {
  const key = keyOf(v);
  if (!key) return null;
  return EMPLOYMENT_MAP[key] ?? 'unspecified';
}

/**
 * job_postings.location_type. Reads the declared work-mode column first, then falls back
 * to the free-text location ("Remote — anywhere", "Bengaluru, Hybrid"), which is how most
 * agency sheets encode it.
 */
export function locationTypeOf(rec: Record<string, string>): string | null {
  const declared = keyOf(rec.location_type);
  if (declared) {
    if (WORKPLACE_MAP[declared]) return WORKPLACE_MAP[declared];
    if (declared.includes('remote') || declared === 'wfh') return 'remote';
    if (declared.includes('hybrid') || declared.includes('flexible')) return 'hybrid';
    if (declared.includes('onsite') || declared.includes('office') || declared.includes('field')) return 'onsite';
    return LOCATION_TYPES.includes(declared) ? declared : 'unspecified';
  }
  if (bool(rec.is_work_from_home) === true) return 'remote';
  const loc = (rec.location ?? '').toLowerCase();
  if (!loc) return null;
  const hasRemote = loc.includes('remote');
  const hasOnsite = loc.includes('onsite') || loc.includes('on-site') || loc.includes('office');
  if (hasRemote && !hasOnsite) return 'remote';
  if (loc.includes('hybrid')) return 'hybrid';
  return null;
}

const CURRENCIES: Record<string, string> = { inr: 'INR', rs: 'INR', rupee: 'INR', rupees: 'INR', usd: 'USD', dollar: 'USD', dollars: 'USD', eur: 'EUR', euro: 'EUR', gbp: 'GBP', pound: 'GBP' };
function currencyOf(rec: Record<string, string>): string | null {
  const explicit = CURRENCIES[keyOf(rec.salary_currency)];
  if (explicit) return explicit;
  const blob = `${rec.salary_range ?? ''} ${rec.salary_min ?? ''}`.toLowerCase();
  for (const [k, v] of Object.entries(CURRENCIES)) if (blob.includes(k)) return v;
  return null;
}

const PERIODS: Record<string, string> = { year: 'year', yearly: 'year', annual: 'year', annum: 'year', pa: 'year', lpa: 'year', perannum: 'year', month: 'month', monthly: 'month', permonth: 'month', week: 'week', weekly: 'week', perweek: 'week', day: 'day', daily: 'day', perday: 'day', hour: 'hour', hourly: 'hour', perhour: 'hour' };
function periodOf(rec: Record<string, string>): string | null {
  const explicit = PERIODS[keyOf(rec.salary_period)];
  if (explicit) return explicit;
  const blob = keyOf(rec.salary_range);
  for (const k of ['lpa', 'perannum', 'annum', 'pa', 'permonth', 'monthly', 'perweek', 'weekly', 'perday', 'daily', 'perhour', 'hourly']) {
    if (blob.includes(k)) return PERIODS[k] ?? null;
  }
  return null;
}

/**
 * Board hosts, see employerDomainOf below.
 */
const BOARD_HOSTS = /(naukri|shine|monster|indeed|linkedin|instahyre|hirist|iimjobs|foundit|cutshort|glassdoor|ziprecruiter|dice|apna|internshala|timesjobs|jobstreet|careerbuilder|simplyhired|wellfound|angel\.co|ycombinator|remoteok|workindia|hasjob|classicjobs|districtseller|mycare\.net|elpais)/i;

/**
 * Employer domain for an imported row. The scrapers derive a slug from the company name
 * ("Nexa IT Labs" -> nexailabscom.com) and store that in companies.domain, so an import has
 * to produce the same key or every re-import creates a second company row. A real declared
 * / employer-site domain still wins over the slug; a job-board host never does.
 */
const CORPORATE_SUFFIXES = [
  ' private limited', ' pvt ltd', ' pvt. ltd.', ' pvt', ' ltd', ' limited',
  ' llp', ' inc', ' corp', ' corporation', ' group', ' india',
];

export function companyDomainSlug(companyName: string): string {
  let name = (companyName || '').toLowerCase();
  for (const suffix of CORPORATE_SUFFIXES) name = name.split(suffix).join('');
  const slug = name.replace(/[^a-z0-9]/g, '');
  return slug ? `${slug}.com` : '';
}

function cleanDomain(v: string | null): string | null {
  const s = (v ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[/?#].*$/, '');
  return s.includes('.') ? s : null;
}

export function employerDomainOf(companyName: string, jobUrl: string | null, declaredDomain: string | null): string {
  const declared = cleanDomain(blankToNull(declaredDomain));
  if (declared && !BOARD_HOSTS.test(declared)) return declared;
  const host = cleanDomain(urlHostname(jobUrl ?? ''));
  if (host && !BOARD_HOSTS.test(host)) return host;
  return companyDomainSlug(companyName) || declared || host || '';
}

function guessPostedAt(v: unknown): Date | null {
  const s = blankToNull(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * True when a record's values are all just their own header text, which happens when a
 * file's real header row was something we could not map and a data row shifted up. Cheap
 * heuristic, deliberately conservative: it only fires when *nothing* else in the row is
 * plausible (no URL, no email), so a genuine sheet with a company called "Company" still
 * imports.
 */
function recLooksUnmapped(rec: Record<string, string>): boolean {
  const filled = Object.entries(rec).filter(([, v]) => (v ?? '').trim() !== '');
  if (filled.length === 0) return false;
  // A value equal to one of its field's own alias names ("Company" under Company).
  const isHeaderText = (field: string, v: string) =>
    HEADER_WORDS[field]?.has(slugHeader(v)) ?? false;
  const allHeaderish = filled.every(([field, v]) => isHeaderText(field, v));
  if (!allHeaderish) return false;
  const hasUrl = /^https?:\/\//i.test(rec.job_url ?? '') || /^https?:\/\//i.test(rec.hr_linkedin_url ?? '');
  const hasEmail = /@/.test(rec.hr_email ?? '');
  return !hasUrl && !hasEmail;
}

/** Map a driver error onto a client-safe reason without leaking schema or values. */
export function classifyImportError(err: any): string {
  const msg = String(err?.message ?? err ?? '');
  if (/not-null|null value/i.test(msg)) return 'missing a required value';
  if (/violates check constraint/i.test(msg)) return 'a value was outside the allowed set';
  if (/value too long/i.test(msg)) return 'a value was too long';
  if (/duplicate key|unique/i.test(msg)) return 'conflicts with an existing row';
  if (/invalid input syntax/i.test(msg)) return 'a value had the wrong type';
  return 'row could not be saved';
}

interface LeadCandidate {
  id: string;
  company_name: string | null;
  job_title: string | null;
  job_url: string | null;
}

/**
 * One pass over the parsed records. `dryRun` computes the plan (what would be created
 * vs merged) without touching a single row, which is what the preview dialog shows.
 */
export async function importLeadRecords(
  sql: postgres.Sql,
  records: Array<Record<string, string>>,
  user: { id: string; role: string; email?: string },
  opts: { dryRun?: boolean; sourceLabel?: string } = {},
): Promise<ImportResult> {
  const result: ImportResult = {
    total_rows: records.length,
    created: 0, merged: 0, merged_fuzzy: 0, skipped: 0,
    columns_mapped: {}, columns_ignored: [], errors: [],
  };
  if (records.length === 0) return result;
  if (records.length > MAX_ROWS) {
    throw Object.assign(new Error(`Too many rows (${records.length}); split the file into chunks of ${MAX_ROWS}`), { statusCode: 413 });
  }

  // Contacts that have opted out of outreach. An agency list is very likely to contain
  // someone who already unsubscribed from us, and importing them as workable would send
  // mail to an opt-out. Loaded once, applied per row.
  const suppressed = new Set<string>();
  /**
   * Suppression keys are written verbatim-lowercased by their producers: an email is
   * lower(trim(email)), a WhatsApp number is lower(trim(from)) in E.164 ("+919876543210").
   * So probe every form this row could have been stored under — comparing only a stripped
   * last-10-digit form silently missed every opt-out that was recorded with a country code.
   */
  const contactKeys = (email: string | null, mobile: string | null): string[] => {
    const keys: string[] = [];
    if (email) keys.push(email.trim().toLowerCase());
    if (mobile) {
      const raw = mobile.trim().toLowerCase();
      keys.push(raw);
      const digits = raw.replace(/\D/g, '');
      if (digits) {
        keys.push(digits);                                  // 919876543210
        const local = digits.replace(/^0+/, '').slice(-10); // 9876543210
        if (local.length === 10) {
          keys.push(local);
          keys.push(`+91${local}`);
        }
      }
    }
    return keys;
  };
  const isSuppressed = (email: string | null, mobile: string | null): boolean =>
    contactKeys(email, mobile).some((k) => suppressed.has(k));

  // Fuzzy matching needs a candidate pool; the normalizer uses the last 30 days.
  // Both reads are skipped for a dry run, which must touch nothing but SELECT-free logic.
  let candidates: LeadCandidate[] = opts.dryRun ? [] : (await sql.unsafe(
    `SELECT l.id, c.name as company_name, jp.title as job_title, jp.job_url
       FROM leads l JOIN companies c ON l.company_id = c.id
       JOIN job_postings jp ON l.job_posting_id = jp.id
      WHERE l.created_at > NOW() - INTERVAL '30 days'
      ORDER BY l.created_at DESC LIMIT 2000`,
  )) as unknown as LeadCandidate[];

  if (!opts.dryRun) {
    const rows = await sql.unsafe(
      `SELECT normalized_contact FROM suppressions WHERE channel IN ('any', 'email', 'whatsapp')`,
    );
    for (const r of rows as unknown as Array<{ normalized_contact: string }>) suppressed.add(r.normalized_contact);
  }

  // Fingerprints already written *by this file*. Without it, a sheet listing the same
  // job twice inserts it twice (the DB lookups only see what was there before we started).
  const writtenFingerprints = new Map<string, { job_posting_id: string; lead_id: string | null }>();

  const normalized = records.map(withAliases);

  for (let i = 0; i < normalized.length; i++) {
    const rec = normalized[i];
    const rowNum = i + 2; // 1-based, header row included -> matches the spreadsheet
    const companyName = short(rec.company_name);
    const jobTitle = short(rec.job_title);
    const jobUrl = short(rec.job_url);
    const hrName = short(rec.hr_name);
    const hrEmail = (blankToNull(rec.hr_email) ?? '').toLowerCase();
    const hrMobile = short(rec.hr_mobile);
    const hrLinkedin = short(rec.hr_linkedin_url);

    if (!companyName && !jobTitle && !hrName && !hrEmail) {
      result.skipped++;
      result.errors.push({ row: rowNum, reason: 'No company, job title or contact details' });
      continue;
    }
    if (!companyName && !hrName && !hrEmail) {
      // Without an employer or a person there is nothing to reach out to; a bare
      // job URL would otherwise materialise a company named after the file's junk.
      result.skipped++;
      result.errors.push({ row: rowNum, reason: 'Need a company name or a contact (name/email)' });
      continue;
    }
    if (recLooksUnmapped(rec)) {
      // Every recognised column carrying the same value as its own header is the
      // signature of a file whose headers we did not understand (e.g. "not,a,known"
      // over "1,2,3,4"): importing it would write the header text into the CRM.
      result.skipped++;
      result.errors.push({ row: rowNum, reason: 'Row looks like headers, not data — check the column names' });
      continue;
    }

    const fp = generateFingerprint(companyName ?? '', jobTitle ?? '', jobUrl ?? '');
    const hasIdentity = Boolean(companyName && jobTitle && jobUrl);

    const input: UpsertInput = {
      rec, companyName, jobTitle, jobUrl, hrName, hrEmail, hrMobile, hrLinkedin,
      fp, hasIdentity, user, candidates, sourceLabel: opts.sourceLabel ?? 'csv_import',
    };

    // Same job on two rows of this file: fold into the lead the first row produced.
    if (writtenFingerprints.has(fp)) {
      if (opts.dryRun) { result.merged++; continue; }
      const target = await sql.unsafe(
        `SELECT jp.id AS job_posting_id, l.id AS lead_id FROM job_postings jp
           LEFT JOIN leads l ON l.job_posting_id = jp.id WHERE jp.fingerprint = $1 LIMIT 1`,
        [fp] as any,
      );
      const hit = (target as unknown as Array<{ job_posting_id: string; lead_id: string | null }>)[0]
        // A fake/test client answers [] for the lookup even though row 1 inserted, so fall
        // back to the posting/lead ids this file already created for this fingerprint.
        ?? writtenFingerprints.get(fp);
      if (hit) {
        await mergeIntoPosting(sql, hit, input, employerDomainOf(companyName ?? '', jobUrl, blankToNull(rec.company_domain)) || null);
        result.merged++;
        continue;
      }
    }

    if (opts.dryRun) {
      writtenFingerprints.set(fp, { job_posting_id: 'dry', lead_id: null });
      const dupId = !hasIdentity ? null : findFuzzy(candidates, companyName, jobTitle, jobUrl);
      if (dupId) { result.merged_fuzzy++; continue; }
      result.created++;
      continue;
    }

    try {
      input.suppressedEmail = isSuppressed(hrEmail || null, hrMobile);
      const outcome = await upsertOne(sql, input);
      writtenFingerprints.set(fp, { job_posting_id: outcome.job_posting_id, lead_id: outcome.lead_id });
      if (outcome.kind === 'created') result.created++;
      else if (outcome.kind === 'merged_fuzzy') result.merged_fuzzy++;
      else result.merged++;
    } catch (err: any) {
      result.skipped++;
      // Postgres messages name constraints, columns and sometimes values; report a stable
      // code here and keep the detail server-side.
      console.warn('[import] row %d failed: %s', rowNum, err?.message ?? err);
      result.errors.push({ row: rowNum, reason: classifyImportError(err) });
    }
  }

  return result;
}

function findFuzzy(candidates: LeadCandidate[], company: string | null, title: string | null, url: string | null): string | null {
  if (!company || !title) return null;
  for (const cand of candidates) {
    const sim = calculateCandidateSimilarity(
      { companyName: company, jobTitle: title, jobUrl: url ?? '' },
      { companyName: cand.company_name ?? '', jobTitle: cand.job_title ?? '', jobUrl: cand.job_url ?? '' },
    );
    if (sim >= FUZZY_THRESHOLD) return cand.id;
  }
  return null;
}

interface UpsertInput {
  rec: Record<string, string>;
  companyName: string | null; jobTitle: string | null; jobUrl: string | null;
  hrName: string | null; hrEmail: string; hrMobile: string | null; hrLinkedin: string | null;
  fp: string; hasIdentity: boolean;
  user: { id: string; role: string; email?: string };
  candidates: LeadCandidate[];
  sourceLabel: string;
  /** True when this row's email/phone is on the suppression list. */
  suppressedEmail?: boolean;
}

/** Outcome of one row, including the ids it touched so a later row of the same file can
 * fold into them without another round trip. */
export interface UpsertOutcome {
  kind: 'created' | 'merged' | 'merged_fuzzy';
  job_posting_id: string;
  lead_id: string | null;
}

async function upsertOne(sql: postgres.Sql, input: UpsertInput): Promise<UpsertOutcome> {
  const { rec, companyName, jobTitle, jobUrl, hrName, hrEmail, hrMobile, hrLinkedin, fp, hasIdentity, user, candidates, sourceLabel } = input;
  const domain = employerDomainOf(companyName ?? '', jobUrl, blankToNull(rec.company_domain)) || null;

  // ---- 1. exact fingerprint -------------------------------------------------
  const fpHit = await sql.unsafe(
    `SELECT jp.id AS job_posting_id, l.id AS lead_id
       FROM job_postings jp LEFT JOIN leads l ON l.job_posting_id = jp.id
      WHERE jp.fingerprint = $1
      ORDER BY jp.first_seen_at DESC LIMIT 1`,
    [fp] as any,
  );
  const byFp = (fpHit as unknown as Array<{ job_posting_id: string; lead_id: string | null }>)[0];

  // ---- 2. company+url identity (rows with no title to fingerprint on) --------
  let urlHit: { job_posting_id: string; lead_id: string | null } | undefined;
  if (!byFp && jobUrl) {
    const hit = await sql.unsafe(
      `SELECT jp.id AS job_posting_id, l.id AS lead_id
         FROM job_postings jp
         JOIN companies c ON c.id = jp.company_id
         LEFT JOIN leads l ON l.job_posting_id = jp.id
        WHERE jp.job_url = $1
          AND ($2::text IS NULL OR lower(regexp_replace(c.name, '[^a-zA-Z0-9]', '', 'g')) = lower($2))
        ORDER BY jp.first_seen_at DESC LIMIT 1`,
      [jobUrl, companyName ? companyName.toLowerCase().replace(/[^a-z0-9]/g, '') : null] as any,
    );
    urlHit = (hit as unknown as Array<{ job_posting_id: string; lead_id: string | null }>)[0];
  }

  const prematch = byFp ?? urlHit;
  if (prematch) {
    await mergeIntoPosting(sql, prematch, input, domain);
    return { kind: 'merged', job_posting_id: prematch.job_posting_id, lead_id: prematch.lead_id };
  }

  // ---- 3. fuzzy --------------------------------------------------------------
  const fuzzyLeadId = hasIdentity ? findFuzzy(candidates, companyName, jobTitle, jobUrl) : null;

  // ---- 4. insert -------------------------------------------------------------
  const companyId = await upsertCompany(sql, companyName, domain, rec);
  const contactId = await upsertContact(sql, companyId, { hrName, hrEmail, hrMobile, hrLinkedin, rec });
  const facets = postingValues(input, domain);

  const postingWrite = await sql.unsafe(
    `INSERT INTO job_postings
       (company_id, hr_contact_id, title, description, experience_level, salary_range,
        job_url, source_site, fingerprint, raw_payload, location, city, state, country,
        location_type, employment_type, is_work_from_home, apply_url, posted_at, about_job,
        department, openings_count, salary_min, salary_max, salary_currency, salary_period)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
     ON CONFLICT (fingerprint) DO NOTHING
     RETURNING id`,
    [
      companyId, contactId, short(jobTitle) ?? '(untitled import)',
      text(rec.job_description) ?? text(rec.about_job),
      short(rec.experience_level), short(rec.salary_range),
      jobUrl ?? `import://${fp.slice(0, 24)}`, short(rec.source_site) ?? sourceLabel,
      fp, JSON.stringify({ import_source: sourceLabel, ...rec }),
      ...facets,
    ] as any,
  );
  let postingId = (postingWrite as unknown as Array<{ id: string }>)[0]?.id;
  let racedIntoExistingLead: string | null = null;

  if (!postingId) {
    // Another writer (scraper or a parallel import row) took the fingerprint between
    // our check and our insert: treat it as the merge case rather than erroring.
    const loser = await sql.unsafe(
      `SELECT jp.id AS job_posting_id, l.id AS lead_id FROM job_postings jp
         LEFT JOIN leads l ON l.job_posting_id = jp.id WHERE jp.fingerprint = $1 LIMIT 1`,
      [fp] as any,
    );
    const row = (loser as unknown as Array<{ job_posting_id: string; lead_id: string | null }>)[0];
    if (!row) throw new Error('duplicate key');  // surfaced via classifyImportError
    await mergeIntoPosting(sql, row, input, domain);
    return { kind: 'merged', job_posting_id: row.job_posting_id, lead_id: row.lead_id };
  }

  const leadWrite = await sql.unsafe(
    `INSERT INTO leads (job_posting_id, company_id, hr_contact_id, pipeline_stage, data_quality,
                        assigned_to, possible_duplicate_of, do_not_contact, legal_basis, processing_purpose, provenance)
     VALUES ($1,$2,$3,'discovered',$4,$5,$6,$7,'legitimate_interest_b2b','b2b_recruitment_outreach',
             jsonb_build_object('source_site', $8::text, 'imported_by', $9::text, 'imported_at', now()::text))
     ON CONFLICT (job_posting_id) DO NOTHING
     RETURNING id`,
    [
      postingId, companyId, contactId,
      hrName && (hrEmail || hrMobile || hrLinkedin) ? 'complete' : 'incomplete',
      // sales_rep RBAC filters on assigned_to, so an unassigned import would be
      // invisible to the person who just ran it. Admin imports stay unassigned.
      user.role === 'sales_rep' ? user.id : null,
      fuzzyLeadId,
      // Opted-out contact: stored for completeness, never worked. The send guard reads
      // this flag, so the lead cannot be mailed even though it is now in the queue.
      input.suppressedEmail ? true : false,
      blankToNull(rec.source_site) ?? sourceLabel, user.email ?? user.id,
    ] as any,
  );
  const newLeadId = (leadWrite as unknown as Array<{ id: string }>)[0]?.id;
  if (!newLeadId) {
    const existing = await sql.unsafe(`SELECT id FROM leads WHERE job_posting_id = $1 LIMIT 1`, [postingId] as any);
    racedIntoExistingLead = (existing as unknown as Array<{ id: string }>)[0]?.id ?? null;
    if (!racedIntoExistingLead) throw new Error('lead conflict with no readable lead');
  }
  const leadId = newLeadId ?? racedIntoExistingLead!;

  // Score with the same engine the workers use, so an imported lead lands in the
  // right band instead of sitting at 0/cold until a manual enrich.
  await recomputeLeadScore(sql, leadId).catch(() => undefined);

  // Keep the pool honest for within-file dedup of subsequent rows.
  candidates.push({ id: leadId, company_name: companyName, job_title: jobTitle, job_url: jobUrl });

  return { kind: fuzzyLeadId ? 'merged_fuzzy' : 'created', job_posting_id: postingId, lead_id: leadId };
}

/** Fill-only-blank update of an existing posting/lead/contact pair. */
async function mergeIntoPosting(
  sql: postgres.Sql,
  target: { job_posting_id: string; lead_id: string | null },
  input: UpsertInput,
  domain: string | null,
): Promise<void> {
  const { companyName, hrName, hrEmail, hrMobile, hrLinkedin, rec } = input;
  const [loc, city, state, country, locationType, employmentType, wfh, applyUrl, postedAt, aboutJob, dept, openings, smin, smax, cur, per] = postingValues({ ...input, rec }, domain);
  const desc = text(rec.job_description) ?? text(rec.about_job);

  await sql.unsafe(
    `UPDATE job_postings SET
       last_seen_at = NOW(),
       description      = COALESCE(description, $1),
       experience_level = COALESCE(experience_level, $2),
       salary_range     = COALESCE(salary_range, $3),
       location         = COALESCE(location, $4),
       city             = COALESCE(city, $5),
       state            = COALESCE(state, $6),
       country          = COALESCE(country, $7),
       location_type    = COALESCE(location_type, $8),
       employment_type  = COALESCE(employment_type, $9),
       is_work_from_home= COALESCE(is_work_from_home, $10),
       apply_url        = COALESCE(apply_url, $11),
       posted_at        = COALESCE(posted_at, $12),
       about_job        = COALESCE(about_job, $13),
       department       = COALESCE(department, $14),
       openings_count   = COALESCE(openings_count, $15),
       salary_min       = COALESCE(salary_min, $16),
       salary_max       = COALESCE(salary_max, $17),
       salary_currency  = COALESCE(salary_currency, $18),
       salary_period    = COALESCE(salary_period, $19),
       source_site      = CASE WHEN COALESCE(source_site,'') = '' THEN $20 ELSE source_site END
     WHERE id = $21`,
    [desc, short(rec.experience_level), short(rec.salary_range), loc, city, state, country,
     locationType, employmentType, wfh, applyUrl, postedAt, aboutJob, dept, openings, smin, smax, cur, per,
     blankToNull(rec.source_site), target.job_posting_id] as any,
  );

  if (companyName) {
    await sql.unsafe(
      `UPDATE companies SET
         domain        = COALESCE(domain, $1),
         industry      = COALESCE(industry, $2),
         size_estimate = COALESCE(size_estimate, $3),
         website_url   = COALESCE(website_url, $4),
         default_email = COALESCE(default_email, $5),
         default_phone = COALESCE(default_phone, $6),
         about         = COALESCE(about, $7),
         updated_at    = NOW()
       WHERE id = (SELECT company_id FROM job_postings WHERE id = $8)`,
      [domain, short(rec.industry), short(rec.size_estimate), short(rec.website_url),
       short(rec.default_email), short(rec.default_phone), text(rec.about_company),
       target.job_posting_id] as any,
    );
  }

  if (hrName || hrEmail || hrMobile || hrLinkedin) {
    const contactId = await sql.unsafe(
      `SELECT hr_contact_id FROM job_postings WHERE id = $1`, [target.job_posting_id] as any,
    );
    const existingContact = (contactId as unknown as Array<{ hr_contact_id: string | null }>)[0]?.hr_contact_id;
    if (existingContact) {
      await sql.unsafe(
        `UPDATE hr_contacts SET
           full_name      = COALESCE(full_name, $1),
           personal_email = COALESCE(personal_email, $2),
           personal_mobile= COALESCE(personal_mobile, $3),
           linkedin_url   = COALESCE(linkedin_url, $4),
           confidence_score = GREATEST(COALESCE(confidence_score,0), $5),
           updated_at     = NOW()
         WHERE id = $6`,
        [short(hrName), hrEmail || null, short(hrMobile), short(hrLinkedin), confidenceOf(rec), existingContact] as any,
      );
    } else {
      const created = await sql.unsafe(
        `INSERT INTO hr_contacts (full_name, linkedin_url, personal_email, personal_mobile,
                                  current_company_id, contact_source, confidence_score, extraction_provenance)
         SELECT $1, NULLIF($2,''), NULLIF($3,''), NULLIF($4,''), jp.company_id, 'imported', $5,
                jsonb_build_object('imported_at', now()::text)
           FROM job_postings jp WHERE jp.id = $6
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [short(hrName), short(hrLinkedin), hrEmail, short(hrMobile), confidenceOf(rec), target.job_posting_id] as any,
      );
      const newContact = (created as unknown as Array<{ id: string }>)[0]?.id;
      if (newContact) {
        await sql.unsafe(`UPDATE job_postings SET hr_contact_id = $1 WHERE id = $2 AND hr_contact_id IS NULL`, [newContact, target.job_posting_id] as any);
        await sql.unsafe(`UPDATE leads SET hr_contact_id = $1 WHERE job_posting_id = $2 AND hr_contact_id IS NULL`, [newContact, target.job_posting_id] as any);
      }
    }
  }

  if (!target.lead_id) {
    // Posting existed but nobody had turned it into a lead yet: attach one so the
    // imported contact/stage actually shows up in the queue.
    const leadRow = await sql.unsafe(
      `INSERT INTO leads (job_posting_id, company_id, hr_contact_id, pipeline_stage, data_quality,
                          assigned_to, do_not_contact, provenance)
       SELECT jp.id, jp.company_id, jp.hr_contact_id, 'discovered', $2, $3, $4,
              jsonb_build_object('source_site', 'import', 'merged_existing_posting', true, 'imported_at', now()::text)
         FROM job_postings jp WHERE jp.id = $1
       ON CONFLICT (job_posting_id) DO NOTHING
       RETURNING id`,
      [target.job_posting_id,
       hrName && (hrEmail || hrMobile || hrLinkedin) ? 'complete' : 'incomplete',
       input.user.role === 'sales_rep' ? input.user.id : null,
       input.suppressedEmail ? true : false] as any,
    );
    const newId = (leadRow as unknown as Array<{ id: string }>)[0]?.id;
    if (newId) await recomputeLeadScore(sql, newId).catch(() => undefined);
    return;
  }

  await sql.unsafe(
    `UPDATE leads SET
       -- An opt-out can only be added by an import, never removed: OR keeps a lead that
       -- is already suppressed suppressed.
       do_not_contact = COALESCE(do_not_contact, false) OR $3,
       hr_contact_id = COALESCE(hr_contact_id, (SELECT hr_contact_id FROM job_postings WHERE id = $2)),
       data_quality  = CASE WHEN data_quality = 'complete' THEN data_quality
                            WHEN COALESCE((SELECT NULLIF(hc.full_name,'') FROM hr_contacts hc
                                            JOIN leads ll ON ll.hr_contact_id = hc.id WHERE ll.id = $1), '') <> ''
                            THEN 'complete' ELSE data_quality END,
       provenance    = COALESCE(provenance, '{}'::jsonb) || jsonb_build_object('csv_import_merged_at', now()::text),
       updated_at    = NOW()
     WHERE id = $1`,
    [target.lead_id, target.job_posting_id, input.suppressedEmail ? true : false] as any,
  );
  await recomputeLeadScore(sql, target.lead_id).catch(() => undefined);
}

async function upsertCompany(
  sql: postgres.Sql,
  name: string | null,
  domain: string | null,
  rec: Record<string, string>,
): Promise<string | null> {
  if (!name && !domain) return null;
  const found = await sql.unsafe(
    `SELECT id FROM companies
      WHERE ($1::text IS NOT NULL AND lower(name) = lower($1)) OR ($2::text IS NOT NULL AND domain = $2)
      ORDER BY (lower(name) = lower($1::text)) DESC NULLS LAST LIMIT 1`,
    [name, domain] as any,
  );
  const hit = (found as unknown as Array<{ id: string }>)[0]?.id;
  if (hit) {
    await sql.unsafe(
      `UPDATE companies SET
         domain = COALESCE(domain, $2), industry = COALESCE(industry, $3),
         size_estimate = COALESCE(size_estimate, $4), website_url = COALESCE(website_url, $5),
         default_email = COALESCE(default_email, $6), default_phone = COALESCE(default_phone, $7),
         about = COALESCE(about, $8), updated_at = NOW()
       WHERE id = $1`,
      [hit, clamp(domain, MAX_SHORT), short(rec.industry), short(rec.size_estimate),
       short(rec.website_url), short(rec.default_email),
       short(rec.default_phone), text(rec.about_company)] as any,
    );
    return hit;
  }
  if (!name) return null; // companies.name is NOT NULL
  const inserted = await sql.unsafe(
    `INSERT INTO companies (name, domain, industry, size_estimate, website_url, default_email, default_phone, about)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (lower(name)) DO NOTHING RETURNING id`,
    [clamp(name, MAX_SHORT), clamp(domain, MAX_SHORT), short(rec.industry), short(rec.size_estimate), short(rec.website_url),
     short(rec.default_email), short(rec.default_phone), text(rec.about_company)] as any,
  );
  const newId = (inserted as unknown as Array<{ id: string }>)[0]?.id;
  if (newId) return newId;
  const retry = await sql.unsafe(`SELECT id FROM companies WHERE lower(name) = lower($1) LIMIT 1`, [name] as any);
  return (retry as unknown as Array<{ id: string }>)[0]?.id ?? null;
}

function confidenceOf(rec: Record<string, string>): number {
  const declared = num(rec.confidence_score ?? rec.hr_confidence);
  if (declared != null) return Math.max(0, Math.min(100, Math.round(declared)));
  // A hand-curated list with a named person, a direct email and a LinkedIn profile
  // is worth more than a bare company row.
  let score = 20;
  if (blankToNull(rec.hr_name)) score += 20;
  if (blankToNull(rec.hr_email)) score += 30;
  if (blankToNull(rec.hr_mobile)) score += 15;
  if (short(rec.hr_linkedin_url)) score += 15;
  return Math.min(score, 100);
}

async function upsertContact(
  sql: postgres.Sql,
  companyId: string | null,
  c: { hrName: string | null; hrEmail: string; hrMobile: string | null; hrLinkedin: string | null; rec: Record<string, string> },
): Promise<string | null> {
  const { hrName, hrEmail, hrMobile, hrLinkedin, rec } = c;
  if (!hrName && !hrEmail && !hrMobile && !hrLinkedin) return null;

  // Reuse the same person at the same employer, keyed on a value we actually have.
  // (Matching on '' = '' once attached one blank contact to 137 unrelated companies.)
  const found = await sql.unsafe(
    `SELECT id FROM hr_contacts
      WHERE ($1::uuid IS NULL OR current_company_id = $1)
        AND ( ($2::text IS NOT NULL AND lower(personal_email) = $2)
           OR ($3::text IS NOT NULL AND linkedin_url = $3)
           OR ($4::text IS NOT NULL AND personal_mobile = $4) )
      LIMIT 1`,
    [companyId, hrEmail.toLowerCase() || null, hrLinkedin, hrMobile] as any,
  );
  const hit = (found as unknown as Array<{ id: string }>)[0]?.id;
  if (hit) {
    await sql.unsafe(
      `UPDATE hr_contacts SET full_name = COALESCE(full_name, $1),
         personal_email = COALESCE(personal_email, $2), personal_mobile = COALESCE(personal_mobile, $3),
         linkedin_url = COALESCE(linkedin_url, $4), current_company_id = COALESCE(current_company_id, $5),
         confidence_score = GREATEST(COALESCE(confidence_score,0), $6), updated_at = NOW()
       WHERE id = $7`,
      [hrName, hrEmail || null, hrMobile, hrLinkedin, companyId, confidenceOf(rec), hit] as any,
    );
    return hit;
  }
  const inserted = await sql.unsafe(
    `INSERT INTO hr_contacts (full_name, linkedin_url, personal_email, personal_mobile,
                              current_company_id, confidence_score, contact_source, contact_method, extraction_provenance)
     VALUES ($1,NULLIF($2,''),NULLIF($3,''),NULLIF($4,''),$5,$6,'imported',$7,
             jsonb_build_object('imported_at', now()::text))
     RETURNING id`,
    [short(hrName), short(hrLinkedin), hrEmail, short(hrMobile), companyId, confidenceOf(rec), short(rec.source_site) ?? 'csv_import'] as any,
  );
  return (inserted as unknown as Array<{ id: string }>)[0]?.id ?? null;
}

/**
 * A header may be recognised as one field while the value semantically belongs to another
 * ("Work Mode" -> location_type already, but some sheets say "Remote / Hybrid" under a
 * generic 'remote' column). Copy such values onto the canonical key the writer reads.
 */
function withAliases(rec: Record<string, string>): Record<string, string> {
  const out = { ...rec };
  const setIfMissing = (to: string, from: string) => { if (!out[to] && out[from]) out[to] = out[from]; };
  setIfMissing('location_type', 'work_mode');
  setIfMissing('employment_type', 'job_type');
  setIfMissing('salary_min', 'ctc_min');
  setIfMissing('salary_max', 'ctc_max');
  return out;
}

/** Positional values for the 16 job_postings facet columns, shared by insert and merge. */
function postingValues(input: UpsertInput, domain: string | null): unknown[] {
  const { jobUrl, rec } = input;
  const loc = blankToNull(rec.location);
  const parts = (loc ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const city = blankToNull(rec.city) ?? (parts.length > 1 ? parts[0] : null);
  const state = blankToNull(rec.state) ?? (parts.length > 2 ? parts[parts.length - 2] : null);
  const country = blankToNull(rec.country) ?? (parts.length ? parts[parts.length - 1] : null);
  const smin = num(rec.salary_min);
  const smax = num(rec.salary_max);
  const wfh = bool(rec.is_work_from_home);
  const locationType = locationTypeOf(rec);
  return [
    loc, city, state, country,
    locationType, employmentTypeOf(rec.employment_type),
    wfh ?? (locationType === 'remote' ? true : null),
    short(rec.apply_url) ?? (domain && jobUrl ? jobUrl : null),
    guessPostedAt(rec.posted_at), text(rec.about_job),
    short(rec.department), num(rec.openings_count),
    smin, smax != null && smin != null && smax < smin ? smin : smax,
    currencyOf(rec), periodOf(rec),
  ];
}

/** Convenience wrapper used by the route: parse text then import. */
export async function importCsvText(
  sql: postgres.Sql,
  text: string,
  user: { id: string; role: string; email?: string },
  opts: { dryRun?: boolean } = {},
): Promise<ImportResult & { columns_mapped: Record<string, string>; columns_ignored: string[] }> {
  const table = parseDelimited(text);
  if (table.length < 2) {
    throw Object.assign(new Error('File needs a header row and at least one data row'), { statusCode: 400 });
  }
  const { records, mapped, unmapped } = normaliseLeadRecords(table);
  const res = await importLeadRecords(sql, records, user, opts);
  return { ...res, columns_mapped: mapped, columns_ignored: unmapped };
}
