import { importLeadRecords, importCsvText } from '../src/utils/importLeads';
import { parseDelimited } from '../src/utils/leadColumns';

/**
 * Dedup is the whole point of the import: pasting another agency's sheet must never
 * create a second copy of a lead we already work. These tests drive the ladder with a
 * recording fake `postgres` client so the decisions (merge vs insert vs flag-fuzzy) are
 * asserted without a database.
 */

type Handler = (sql: string, params: any[]) => any[];

let seq = 0;

function fakeSql(handler: Handler) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const unsafe = jest.fn(async (q: string, params: any[] = []) => {
    calls.push({ sql: q, params });
    const out = handler(q, params);
    // pg returns a row for every successful INSERT ... RETURNING; a fake that always
    // answered [] would make every insert look like an ON CONFLICT no-op.
    // A successful INSERT ... RETURNING yields its row; only the DO NOTHING variants
    // (real conflicts) legitimately come back empty.
    if (out.length === 0 && /^\s*INSERT INTO/i.test(q) && !/ON CONFLICT DO NOTHING/i.test(q)) {
      return [{ id: `gen-${++seq}` }];
    }
    return out;
  });
  return { sql: { unsafe } as any, calls };
}

/** Handler that answers nothing (every dedup lookup misses, inserts succeed). */
const nothing: Handler = () => [];

const HEADER = 'Company,Job Title,Job URL,Location,Salary Range,HR Name,HR Email,HR Mobile,HR LinkedIn';

const fpOf = (company: string, title: string, url: string) =>
  require('../src/utils/leadColumns').generateFingerprint(company, title, url);

const user = { id: '11111111-1111-1111-1111-111111111111', role: 'admin', email: 'admin@test' };

const rowsFrom = (csv: string) => {
  const { records } = require('../src/utils/leadColumns').normaliseLeadRecords(parseDelimited(csv));
  return records;
};

describe('CSV import dedup', () => {
  test('exact fingerprint hit merges into the existing lead and fills blanks only', async () => {
    const csv = `${HEADER}\nAcme,Backend Engineer,https://jobs.acme.com/1,Pune,12-18 LPA,Ravi,ravi@acme.com,,`;
    const { sql, calls } = fakeSql((q) => {
      if (q.includes('FROM job_postings jp LEFT JOIN leads l')) {
        return [{ job_posting_id: 'jp-1', lead_id: 'lead-1' }];
      }
      if (q.includes('SELECT hr_contact_id FROM job_postings')) return [{ hr_contact_id: 'hc-1' }];
      return [];
    });

    const res = await importLeadRecords(sql, rowsFrom(csv), user);

    expect(res).toMatchObject({ total_rows: 1, created: 0, merged: 1, merged_fuzzy: 0, skipped: 0 });
    expect(calls.some((c) => c.sql.includes('UPDATE job_postings SET'))).toBe(true);
    // fill-only-blank: every refreshed column is wrapped in COALESCE
    const update = calls.find((c) => c.sql.includes('UPDATE job_postings SET'))!.sql;
    expect(update).toContain('COALESCE(salary_range');
    expect(update).not.toMatch(/SET\s+salary_range\s*=/);
    // ...and the lead itself was re-scored rather than left at 0
    expect(calls.some((c) => c.sql.includes('lead_score = $1') || c.sql.includes('UPDATE leads SET'))).toBe(true);
    expect(calls.some((c) => /INSERT INTO (leads|job_postings|companies)/i.test(c.sql))).toBe(false);
  });

  test('unknown company+title+url inserts posting and lead', async () => {
    const csv = `${HEADER}\nGlobex,Data Analyst,https://careers.globex.com/da,Bengaluru,,Priya,priya@globex.com,+91999999999,`;
    const { sql, calls } = fakeSql(nothing);   // nothing matches anywhere

    const res = await importLeadRecords(sql, rowsFrom(csv), user);

    expect(res).toMatchObject({ created: 1, merged: 0, skipped: 0 });
    const insPosting = calls.find((c) => /INSERT INTO job_postings/i.test(c.sql))!;
    expect(insPosting).toBeTruthy();
    // fingerprint is what makes a later re-import collapse onto this row
    expect(insPosting.params).toContain(fpOf('Globex', 'Data Analyst', 'https://careers.globex.com/da'));
    expect(calls.some((c) => /INSERT INTO leads/i.test(c.sql))).toBe(true);
    expect(calls.some((c) => /INSERT INTO companies/i.test(c.sql))).toBe(true);
    expect(calls.some((c) => /INSERT INTO hr_contacts/i.test(c.sql))).toBe(true);
  });

  test('duplicate rows inside one file are written once', async () => {
    const two = `${HEADER}\nGlobex,Data Analyst,https://careers.globex.com/da,,,,,\nGlobex,Data Analyst,https://careers.globex.com/da,,,,,\n`;
    const { sql, calls } = fakeSql(nothing);
    const res = await importLeadRecords(sql, rowsFrom(two), user);
    expect(res.created).toBe(1);
    expect(res.merged).toBe(1);
    expect(calls.filter((c) => /INSERT INTO job_postings/i.test(c.sql))).toHaveLength(1);
  });

  test('sales_rep imports are assigned to themselves so RBAC still shows them', async () => {
    const { sql, calls } = fakeSql(nothing);
    await importLeadRecords(sql, rowsFrom(`${HEADER}\nInitech,QA,https://initech.com/qa,,,,,`), { ...user, role: 'sales_rep' });
    const insLead = calls.find((c) => /INSERT INTO leads/i.test(c.sql))!;
    expect(insLead.params).toContain(user.id);
  });

  test('admin imports stay unassigned (queue is shared)', async () => {
    const { sql, calls } = fakeSql(nothing);
    await importLeadRecords(sql, rowsFrom(`${HEADER}\nInitech,QA,https://initech.com/qa,,,,,`), user);
    const insLead = calls.find((c) => /INSERT INTO leads/i.test(c.sql))!;
    expect(insLead.params).not.toContain(user.id);
  });

  test('CHECK-constrained enums are mapped, not passed through raw', async () => {
    const csv = 'Company,Job Title,Job URL,Work Mode,Job Type,Salary Min,Salary Max,Currency\nInitech,Dev,https://initech.com/d,On-site,Permanent,100000,200000,INR';
    const { sql, calls } = fakeSql(nothing);
    await importLeadRecords(sql, rowsFrom(csv), user);
    const p = calls.find((c) => /INSERT INTO job_postings/i.test(c.sql))!.params;
    expect(p).toContain('onsite');
    expect(p).toContain('full_time');
    expect(p).toContain('INR');
    // salary_min <= salary_max is a DB check; an inverted pair would throw the row away
    expect(Number(p[p.indexOf(100000) + 1])).toBeGreaterThanOrEqual(100000);
  });

  test('inverted salary bounds are clamped instead of violating the check constraint', async () => {
    const csv = 'Company,Job Title,Job URL,Salary Min,Salary Max\nInitech,Dev,https://initech.com/inv,300000,100000';
    const { sql, calls } = fakeSql(nothing);
    const res = await importLeadRecords(sql, rowsFrom(csv), user);
    expect(res.skipped).toBe(0);
    const p = calls.find((c) => /INSERT INTO job_postings/i.test(c.sql))!.params;
    const nums = p.filter((v: unknown) => v === 300000 || v === 100000);
    expect(nums).toEqual([300000, 300000]);
  });

  test('rows with no company and no contact are skipped with a reason', async () => {
    const csv = `${HEADER}\n,,,,,,,\nAcme,Only Title,https://acme.com/t,,,,,`;
    const { sql } = fakeSql(nothing);
    const res = await importLeadRecords(sql, rowsFrom(csv), user);
    expect(res.total_rows).toBe(1);   // blank row never reached the ladder at all
  });

  test('fuzzy near-duplicate is inserted but flagged for the Duplicates page', async () => {
    const csv = `${HEADER}\nAcme Industries Pvt Ltd,Senior Backend Engineer,https://acme.com/jobs/be-2,,,,,`;
    const { sql, calls } = fakeSql((q) => {
      if (q.includes("WHERE l.created_at > NOW() - INTERVAL '30 days'")) {
        return [{ id: 'lead-old', company_name: 'Acme Industries', job_title: 'Senior Backend Engineer', job_url: 'https://acme.com/jobs/be-1' }];
      }
      return [];
    });
    const res = await importLeadRecords(sql, rowsFrom(csv), user);
    // Every row lands in exactly one bucket.
    expect(res).toMatchObject({ created: 0, merged: 0, merged_fuzzy: 1, skipped: 0 });
    const insLead = calls.find((c) => /INSERT INTO leads/i.test(c.sql))!;
    expect(insLead.params).toContain('lead-old');
  });

  test('a file whose headers we could not read writes nothing', async () => {
    // "not,a,known,header" maps 'a'->? and the data row would otherwise store the literal
    // text of its own column names as company/contact values.
    const { sql, calls } = fakeSql(nothing);
    const res = await importLeadRecords(
      sql, [{ company_name: 'Company', hr_email: 'Email', job_title: 'Job Title' }], user,
    );
    expect(res.created).toBe(0);
    expect(res.skipped).toBe(1);
    expect(res.errors[0].reason).toMatch(/column names/i);
    expect(calls.some((c) => /^\s*INSERT INTO/i.test(c.sql))).toBe(false);
  });

  test('a real company literally named after a header still imports', async () => {
    const { sql } = fakeSql(nothing);
    const res = await importLeadRecords(
      sql, [{ company_name: 'Company', job_url: 'https://company.com/j1' }], user,
    );
    expect(res.created).toBe(1);
  });

  test('an opted-out contact is imported flagged do_not_contact, never workable', async () => {
    // GDPR/CAN-SPAM: an agency list can contain someone who already unsubscribed. The
    // send guard reads leads.do_not_contact, so importing them unflagged would mail an opt-out.
    const { sql, calls } = fakeSql((q) => {
      if (/FROM suppressions/.test(q)) return [{ normalized_contact: 'optout@acme.com' }, { normalized_contact: '919876543210' }];
      return [];
    });
    const csv = 'Company,Job Title,Job URL,E-mail,Phone\nAcme,Roles,https://acme.com/o1,optout@acme.com,+919876543210';
    const res = await importLeadRecords(sql, rowsFrom(csv), user);
    expect(res.created).toBe(1);
    const insLead = calls.find((c) => /INSERT INTO leads/i.test(c.sql))!;
    expect(insLead.sql).toContain('do_not_contact');
    expect(insLead.params).toContain(true);
  });

  test('merging into an existing lead sets the opt-out flag without clearing it', async () => {
    const { sql, calls } = fakeSql((q) => {
      if (/FROM suppressions/.test(q)) return [{ normalized_contact: 'optout@acme.com' }];
      if (q.includes('FROM job_postings jp LEFT JOIN leads l')) return [{ job_posting_id: 'jp-1', lead_id: 'lead-1' }];
      if (q.includes('SELECT hr_contact_id FROM job_postings')) return [{ hr_contact_id: 'hc-1' }];
      return [];
    });
    await importLeadRecords(sql, rowsFrom('Company,Job Title,Job URL,E-mail\nAcme,Roles,https://acme.com/m,optout@acme.com'), user);
    const upd = calls.find((c) => /UPDATE leads SET/.test(c.sql))!;
    expect(upd.sql).toMatch(/do_not_contact = COALESCE\(do_not_contact, false\) OR \$3/);
    expect(upd.params).toContain(true);
  });

  test('a non-suppressed contact is not flagged', async () => {
    const { sql, calls } = fakeSql((q) => (/FROM suppressions/.test(q) ? [{ normalized_contact: 'other@x.com' }] : []));
    await importLeadRecords(sql, rowsFrom('Company,Job Title,Job URL,E-mail\nAcme,Roles,https://acme.com/o2,fine@acme.com'), user);
    const insLead = calls.find((c) => /INSERT INTO leads/i.test(c.sql))!;
    expect(insLead.params).toContain(false);
  });

  test('dry run writes nothing', async () => {
    const { sql, calls } = fakeSql(nothing);
    const res = await importLeadRecords(sql, rowsFrom(`${HEADER}\nAcme,Be,https://acme.com/1,,,,,`), user, { dryRun: true });
    expect(res.created).toBe(1);
    expect(calls).toHaveLength(0);
  });

  test('oversized files are refused before any query', async () => {
    const { sql } = fakeSql(nothing);
    const many = Array.from({ length: 5001 }, (_, i) => `C${i},T,https://x.com/${i},,,,`);
    await expect(importLeadRecords(sql, rowsFrom(`${HEADER}\n${many.join('\n')}`), user))
      .rejects.toThrow(/split the file/i);
  });

  test('importCsvText reports which headers it understood', async () => {
    const { sql } = fakeSql(nothing);
    const res = await importCsvText(
      sql, 'Company Name,Role,Some Rubbish Column\nAcme,Engineer,x', user, { dryRun: true },
    );
    expect(res.columns_mapped).toMatchObject({ company_name: 'Company Name', job_title: 'Role' });
    expect(res.columns_ignored).toEqual(['Some Rubbish Column']);
  });

  test('a file with only a header is rejected clearly', async () => {
    const { sql } = fakeSql(nothing);
    await expect(importCsvText(sql, 'Company,Job Title\n', user)).rejects.toThrow(/header row/);
  });
});
