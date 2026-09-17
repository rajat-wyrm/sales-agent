/**
 * Column registry for HR Contact exports.
 *
 * Mirrors packages/web/src/lib/contactColumns.ts (asserted by tests).
 * The browser column registry is used for the client-side "selected CSV" export;
 * the server uses this one for the full filtered workbook/CSV.
 */

export interface ContactColumn {
  header: string;
  field: string;
  group: string;
  get: (r: any) => unknown;
  width: number;
}

/** Columns exported for every contact, grouped left to right. */
export const CONTACT_EXPORT_COLUMNS: ContactColumn[] = [
  { header: 'Full Name', field: 'full_name', group: 'Contact', get: (r) => r.full_name || '', width: 28 },
  { header: 'Personal Email', field: 'personal_email', group: 'Contact', get: (r) => r.personal_email || '', width: 30 },
  { header: 'Personal Mobile', field: 'personal_mobile', group: 'Contact', get: (r) => r.personal_mobile || '', width: 20 },
  { header: 'LinkedIn URL', field: 'linkedin_url', group: 'Contact', get: (r) => r.linkedin_url || '', width: 36 },

  { header: 'Company', field: 'company_name', group: 'Company', get: (r) => r.company_name || '', width: 28 },
  { header: 'Company ID', field: 'company_id', group: 'Company', get: (r) => r.company_id || '', width: 36 },

  { header: 'Confidence Score', field: 'confidence_score', group: 'Scoring', get: (r) => r.confidence_score ?? 0, width: 16 },
  { header: 'Contact ID', field: 'id', group: 'Metadata', get: (r) => r.id || '', width: 36 },
  { header: 'Created At', field: 'created_at', group: 'Metadata', get: (r) => r.created_at, width: 20 },
  { header: 'Updated At', field: 'updated_at', group: 'Metadata', get: (r) => r.updated_at, width: 20 },
];

/** Ordered group names, for headers. */
export const CONTACT_EXPORT_GROUPS: string[] = CONTACT_EXPORT_COLUMNS.reduce((acc: string[], c) => {
  if (!acc.includes(c.group)) acc.push(c.group);
  return acc;
}, []);

// ---------------------------------------------------------------------------
// Formula injection guard — reused from leadColumns so every export path
// guards the same way.
// ---------------------------------------------------------------------------

export const FORMULA_OPENERS = /^[-+=@|\t\r\n]/;

export const guardFormula = (v: unknown): string => {
  const s = String(v ?? '');
  return FORMULA_OPENERS.test(s) ? `'${s}` : s;
};

export const csvCell = (v: unknown) => {
  if (v === null || v === undefined) return '';
  const s = String(v).replace(/\r?\n/g, ' ');
  return `"${guardFormula(s).replace(/"/g, '""')}"`;
};

/** CSV built from the same registry as the workbook, so the two never disagree. */
export function contactsToCsv(rows: any[]): string {
  const cols = CONTACT_EXPORT_COLUMNS;
  return '\ufeff' + [
    cols.map((c) => `"${c.header}"`).join(','),
    ...rows.map((r) => cols.map((c) => csvCell(c.get(r))).join(',')),
  ].join('\r\n');
}

/** The SELECT list for contact rows (column aliases must match CONTACT_EXPORT_COLUMNS.field). */
export const CONTACT_SELECT_SQL = `
  hc.id, hc.full_name, hc.linkedin_url, hc.personal_email, hc.personal_mobile,
  hc.confidence_score, hc.current_company_id as company_id,
  hc.created_at, hc.updated_at,
  c.name as company_name`;

/** The FROM block shared by GET /contacts and GET /contacts/export. */
export const CONTACT_FROM_SQL = `
  FROM hr_contacts hc
  LEFT JOIN companies c ON hc.current_company_id = c.id`;
