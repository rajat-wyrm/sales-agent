/**
 * Browser-side mirror of packages/api/src/utils/contactColumns.ts.
 *
 * The API owns the column registry (it also builds the SQL SELECT and the workbook),
 * but this file is loaded by the UI, which must not pull in node's crypto or the
 * server query text. The header order here matches the API registry.
 */

export interface ContactColumn {
  header: string;
  field: string;
  get: (r: any) => unknown;
}

export const CONTACT_COLUMNS: ContactColumn[] = [
  { header: 'Full Name', field: 'full_name', get: (r) => r.full_name || '' },
  { header: 'Personal Email', field: 'personal_email', get: (r) => r.personal_email || '' },
  { header: 'Personal Mobile', field: 'personal_mobile', get: (r) => r.personal_mobile || '' },
  { header: 'LinkedIn URL', field: 'linkedin_url', get: (r) => r.linkedin_url || '' },
  { header: 'Company', field: 'company_name', get: (r) => r.company_name || '' },
  { header: 'Company ID', field: 'company_id', get: (r) => r.company_id || '' },
  { header: 'Confidence Score', field: 'confidence_score', get: (r) => r.confidence_score ?? 0 },
  { header: 'Contact ID', field: 'id', get: (r) => r.id || '' },
  { header: 'Created At', field: 'created_at', get: (r) => r.created_at },
  { header: 'Updated At', field: 'updated_at', get: (r) => r.updated_at },
];

// Mirrors the API's guardFormula(): a value starting with = + - @ | is executed by
// spreadsheet software, so scraped/imported text gets an apostrophe first.
const FORMULA_OPENERS = /^[-+=@|\t\r\n]/;
const guardFormula = (s: string) => (FORMULA_OPENERS.test(s) ? `'${s}` : s);

const csvCell = (v: unknown) => {
  if (v === null || v === undefined) return '';
  const s = String(v).replace(/\r?\n/g, ' ');
  return `"${guardFormula(s).replace(/"/g, '""')}"`;
};

/** CSV built from the same registry the server workbook uses. */
export function contactsToCsv(rows: any[]): string {
  return '\ufeff' + [
    CONTACT_COLUMNS.map((c) => `"${c.header}"`).join(','),
    ...rows.map((r) => CONTACT_COLUMNS.map((c) => csvCell(c.get(r))).join(',')),
  ].join('\r\n');
}
