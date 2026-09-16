import {
  LEAD_EXPORT_COLUMNS,
  LEAD_SELECT_SQL,
  EXPORT_GROUPS,
  parseDelimited,
  normaliseLeadRecords,
  matchHeader,
  generateFingerprint,
} from '../src/utils/leadColumns';
import { buildLeadsWorkbook, buildLeadsCsv } from '../src/utils/leadWorkbook';

/**
 * The export used to be a hand-maintained list that drifted from the query feeding it:
 * columns were named in the workbook but never selected, so they exported blank. These
 * tests pin the contract that keeps that from coming back.
 */
describe('lead column registry (export fidelity)', () => {
  /**
   * Column names a row returned by LEAD_SELECT_SQL actually carries: `tbl.col,`
   * yields `col`, and `expr AS alias` yields `alias`. Split on commas that are not
   * inside a line comment, because several SELECT lines pack many columns.
   */
  const aliasesInSelect = new Set(
    LEAD_SELECT_SQL.split('\n')
      .map((l) => l.replace(/--.*$/, ''))
      .join(' ')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const as = part.match(/\bas\s+([a-z_][a-z0-9_]*)$/i);
        if (as) return as[1];
        const plain = part.match(/(?:^|\.)([a-z_][a-z0-9_]*)$/i);
        return plain ? plain[1] : '';
      })
      .filter(Boolean),
  );

  test('every exported field is present in the SELECT the export runs', () => {
    // 'Location' composes city/state/country and Assigned To falls back to the raw
    // UUID; both are deliberate composites rather than missing columns.
    const DERIVED = new Set(['location', 'assigned_to_email']);
    const missing = LEAD_EXPORT_COLUMNS
      .map((c) => c.field)
      .filter((f) => !DERIVED.has(f) && !aliasesInSelect.has(f));
    expect(missing).toEqual([]);
  });

  test('headers are unique (Excel table with a duplicate column is ambiguous)', () => {
    const headers = LEAD_EXPORT_COLUMNS.map((c) => c.header);
    expect(new Set(headers).size).toBe(headers.length);
  });

  test('every column belongs to a declared group and groups keep source order', () => {
    for (const c of LEAD_EXPORT_COLUMNS) expect(EXPORT_GROUPS).toContain(c.group);
    expect(EXPORT_GROUPS[0]).toBe('Identity');
    expect(EXPORT_GROUPS).toContain('Compensation');
  });

  test('accessors read the row property their field names', () => {
    const offenders = LEAD_EXPORT_COLUMNS.filter((c) => {
      const probe: Record<string, unknown> = {};
      for (const f of aliasesInSelect) probe[f] = `X:${f}`;
      const v = c.get(probe);
      if (v === undefined || v === '' || v === null) return true;
      if (typeof v === 'string' && v.startsWith('X:')) {
        const read = v.slice(2);
        // 'Location' legitimately composes city/state/country; anything else must
        // read the field it declares, otherwise the header lies about the content.
        return read !== c.field && !(c.group === 'Location & terms' && c.header === 'Location');
      }
      return false;
    }).map((c) => `${c.header} (${c.field})`);
    expect(offenders).toEqual([]);
  });
});

describe('CSV/TSV parsing', () => {
  test('handles quoted commas, embedded newlines, doubled quotes and CRLF', () => {
    const table = parseDelimited('Company,Notes\r\nAcme, "one, two"\r\n"Bets, ""the"" farm","line1\nline2"\r\n');
    expect(table).toEqual([
      ['Company', 'Notes'],
      ['Acme', ' one, two'],          // text outside quotes is kept verbatim
      ['Bets, "the" farm', 'line1\nline2'],
    ]);
  });

  test('strips BOM and sniffs tab-separated files', () => {
    const table = parseDelimited('\ufeffCompany\tJob Title\r\nAcme\tEngineer\r\n');
    expect(table[0]).toEqual(['Company', 'Job Title']);
    expect(table[1]).toEqual(['Acme', 'Engineer']);
  });

  test('pads ragged rows so index->header stays valid', () => {
    const table = parseDelimited('A,B,C\n1\n2,x,y\n');
    expect(table.every((r) => r.length === 3)).toBe(true);
  });

  test('maps third-party CRM headers onto canonical fields', () => {
    expect(matchHeader('Company Name')).toBe('company_name');
    expect(matchHeader('E-mail Address')).toBe('hr_email');
    expect(matchHeader('CTC')).toBe('salary_range');
    expect(matchHeader('Linkedin Profile')).toBe('hr_linkedin_url');
    expect(matchHeader('Salary Range')).toBe('salary_range');
    expect(matchHeader('Job Title')).toBe('job_title');
    expect(matchHeader('Email')).toBe('hr_email');
    expect(matchHeader('Our internal notes')).toBe('notes');
    expect(matchHeader('zzz mystery column')).toBeNull();
  });

  test('normaliseLeadRecords keeps only rows with something importable', () => {
    const { records, mapped, unmapped } = normaliseLeadRecords(parseDelimited(
      'Company,Email,Salary\nAcme,a@b.com,"₹12 LPA"\n,,\n,only-email@c.com,\n',
    ));
    expect(mapped.company_name).toBe('Company');
    expect(unmapped).toEqual([]);
    expect(records).toHaveLength(2);
    expect(records[0].hr_email).toBe('a@b.com');
  });

  test('un-does our own formula guard when re-importing an export', () => {
    const { records } = normaliseLeadRecords(parseDelimited('Company\n\'=HYPERLINK(x)'));
    expect(records[0].company_name).toBe('=HYPERLINK(x)');
  });
});

describe('fingerprint parity with scrapers/normalizer.py', () => {
  // Values produced by the Python implementation:
  //   generate_fingerprint("Acme Pvt Ltd", "Backend Engineer!", "https://boards.naukri.com/job/1")
  test('matches python sha256 of normCompany|normTitle|host', () => {
    const crypto = require('crypto');
    const py = (company: string, title: string, url: string) => {
      const host = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
      const raw = `${company.toLowerCase().replace(/[^a-z0-9]/g, '')}|${title.toLowerCase().replace(/[^a-z0-9]/g, '')}|${host}`;
      return crypto.createHash('sha256').update(raw).digest('hex');
    };
    expect(generateFingerprint('Acme Pvt Ltd', 'Backend Engineer!', 'https://boards.naukri.com/job/1'))
      .toBe(py('Acme Pvt Ltd', 'Backend Engineer!', 'https://boards.naukri.com/job/1'));
    expect(generateFingerprint('', '', '')).toBe(py('', '', ''));
    // Case/punctuation-insensitive, so the same job from two boards still collides.
    expect(generateFingerprint('ACME', 'Backend  engineer', 'https://x.com/a'))
      .toBe(generateFingerprint('acme', 'backend engineer', 'https://x.com/b'));
  });
});

describe('formula-injection guard (every writer, one rule)', () => {
  // The server CSV path once had no guard at all because the rule was copy-pasted per
  // writer. All three export routes must neutralise every spreadsheet formula opener.
  const PAYLOADS = ['=SUM(1,2)', '+1', '-1+1', '@SUM(1)', '|calc|x'];

  test('workbook guards every payload', () => {
    for (const p of PAYLOADS) {
      const xml = buildLeadsWorkbook([{ company_name: p } as any], '');
      expect(xml).toContain(`&apos;${xmlEscapeTest(p)}`);
    }
  });

  test('server CSV guards every payload', () => {
    for (const p of PAYLOADS) {
      const csv = buildLeadsCsv([{ company_name: p } as any]);
      expect(csv).toContain(`"'${p}"`);
    }
  });

  test('browser CSV mirrors the same set (source-level parity)', () => {
    const webSrc = require('fs').readFileSync(
      require('path').join(__dirname, '../../web/src/lib/leadColumns.ts'), 'utf8');
    // Same character class, so the two cannot diverge into "one writer forgot -".
    expect(webSrc).toMatch(/FORMULA_OPENERS =\/\^\[-\+=@\\|\\t\\r\\n\]\//);
    expect(webSrc).toContain('guardFormula(s)');
  });

  test('innocuous values are left alone', () => {
    const csv = buildLeadsCsv([{ company_name: 'Acme', hr_email: 'a+b@example.com' } as any]);
    expect(csv).not.toContain("'Acme");
    expect(csv).toContain('"a+b@example.com"');   // '+' is only dangerous leading
  });
});

const xmlEscapeTest = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

describe('workbook builder', () => {
  const rows = [{
    id: 'uuid-1', lead_score: 82, score_band: 'hot', company_name: 'Acme & Co <test>',
    job_title: '=SUM(1,2)', pipeline_stage: 'discovered', created_at: '2026-01-02T03:04:05Z',
    salary_min: '150000', hr_email: 'a@b.com', job_url: 'https://acme.example/job/1',
    location_type: 'remote', city: 'Pune', state: 'MH', country: 'India',
  }];

  test('escapes XML, guards formulas, keeps numbers typed and emits one cell per column', () => {
    const xml = buildLeadsWorkbook(rows, 'admin@example.com');
    expect(xml).toContain('Acme &amp; Co &lt;test&gt;');
    // The formula guard prefixes an apostrophe; SpreadsheetML then escapes it.
    expect(xml).toContain("&apos;=SUM(1,2)");
    expect(xml).toContain('<Data ss:Type="Number">150000</Data>');
    expect(xml).toContain('<Data ss:Type="DateTime">2026-01-02T03:04:05Z</Data>');
    expect(xml).toContain('ss:HRef="https://acme.example/job/1"');
    // every body row: 2 frozen key columns + one cell per column, no more, no less
    const dataRow = xml.slice(xml.lastIndexOf('<Row>'), xml.lastIndexOf('</Row>'));
    const cells = (dataRow.match(/<Cell/g) || []).length;
    expect(cells).toBe(LEAD_EXPORT_COLUMNS.length + 2);
    const headerCells = (xml.match(/ss:StyleID="sHead"/g) || []).length;
    expect(headerCells).toBe(LEAD_EXPORT_COLUMNS.length + 2);
  });

  test('renders empty rows without producing a broken sheet', () => {
    const xml = buildLeadsWorkbook([], '');
    expect(xml).toContain('<Workbook');
    expect(xml.trim().endsWith('</Workbook>')).toBe(true);
    expect(xml).toContain('<Data ss:Type="Number">0</Data>');
  });

  test('CSV export carries the same headers as the workbook', () => {
    const csv = buildLeadsCsv(rows);
    const header = csv.replace('\ufeff', '').split('\r\n')[0];
    expect(header).toBe(LEAD_EXPORT_COLUMNS.map((c) => `"${c.header}"`).join(','));
  });
});
