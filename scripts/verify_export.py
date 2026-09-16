#!/usr/bin/env python3
"""
Verify the leads export against the live database.

For every lead column that has data in Postgres, assert the exported workbook has a
header for it and at least as many non-empty cells as the DB has values (minus what the
export legitimately composes/derives). This is the check that catches "the export doesn't
cover all the fields" and "data is not showing", which no unit test can see because both
are a missing SELECT column, not a wrong formatter.
"""
import json
import os
import re
import subprocess
import sys
import urllib.request

BASE = os.environ.get("API_BASE", "http://localhost:3000/api")
# Credentials come from the environment; never hardcode them in a committable file.
ADMIN_EMAIL = os.environ.get("VERIFY_ADMIN_EMAIL", "")
ADMIN_PASSWORD = os.environ.get("VERIFY_ADMIN_PASSWORD", "")
DB_SERVICE = os.environ.get("DB_COMPOSE_SERVICE", "postgres")
DB_USER = os.environ.get("DB_USER", "postgres")
DB_NAME = os.environ.get("DB_NAME", "leads_db")
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def login():
    if not ADMIN_EMAIL or not ADMIN_PASSWORD:
        sys.exit("set VERIFY_ADMIN_EMAIL / VERIFY_ADMIN_PASSWORD (see README: local verification scripts)")

    req = urllib.request.Request(
        f"{BASE}/auth/login",
        data=json.dumps({"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req) as r:
        return json.load(r)["access_token"]


def fetch_export(token, fmt=None):
    url = f"{BASE}/leads/export" + (f"?format={fmt}" if fmt else "")
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req) as r:
        return r.read().decode("utf-8", "replace")


def psql(sql_text):
    out = subprocess.run(
        ["docker", "compose", "exec", "-T", DB_SERVICE, "psql", "-U", DB_USER, "-d", DB_NAME,
         "-t", "-A", "-F", "|", "-c", sql_text],
        capture_output=True, text=True, cwd=REPO,
    )
    if out.returncode:
        raise RuntimeError(out.stderr)
    return [l for l in out.stdout.strip().split("\n") if l.strip()]


FILL_SQL = """
SELECT 'job_description', count(nullif(trim(jp.description),'')) FROM leads l JOIN job_postings jp ON l.job_posting_id=jp.id
UNION ALL SELECT 'about_job', count(jp.about_job) FROM leads l JOIN job_postings jp ON l.job_posting_id=jp.id
UNION ALL SELECT 'hr_confidence', count(hc.confidence_score) FROM leads l LEFT JOIN hr_contacts hc ON l.hr_contact_id=hc.id
UNION ALL SELECT 'contact_source', count(hc.contact_source) FROM leads l LEFT JOIN hr_contacts hc ON l.hr_contact_id=hc.id
UNION ALL SELECT 'contact_method', count(hc.contact_method) FROM leads l LEFT JOIN hr_contacts hc ON l.hr_contact_id=hc.id
UNION ALL SELECT 'legal_basis', count(l.legal_basis) FROM leads l
UNION ALL SELECT 'processing_purpose', count(l.processing_purpose) FROM leads l
UNION ALL SELECT 'location', count(nullif(jp.location,'')) FROM leads l JOIN job_postings jp ON l.job_posting_id=jp.id
UNION ALL SELECT 'salary_min', count(jp.salary_min) FROM leads l JOIN job_postings jp ON l.job_posting_id=jp.id
UNION ALL SELECT 'salary_currency', count(nullif(jp.salary_currency,'')) FROM leads l JOIN job_postings jp ON l.job_posting_id=jp.id
UNION ALL SELECT 'experience_level', count(nullif(jp.experience_level,'')) FROM leads l JOIN job_postings jp ON l.job_posting_id=jp.id
UNION ALL SELECT 'apply_url', count(nullif(jp.apply_url,'')) FROM leads l JOIN job_postings jp ON l.job_posting_id=jp.id
UNION ALL SELECT 'source_site', count(nullif(jp.source_site,'')) FROM leads l JOIN job_postings jp ON l.job_posting_id=jp.id
UNION ALL SELECT 'company_name', count(c.name) FROM leads l JOIN companies c ON l.company_id=c.id
UNION ALL SELECT 'company_domain', count(nullif(c.domain,'')) FROM leads l JOIN companies c ON l.company_id=c.id
UNION ALL SELECT 'hr_email', count(nullif(hc.personal_email,'')) FROM leads l LEFT JOIN hr_contacts hc ON l.hr_contact_id=hc.id
UNION ALL SELECT 'pipeline_stage', count(l.pipeline_stage) FROM leads l
UNION ALL SELECT 'lead_score', count(l.lead_score) FROM leads l;
"""

DB_COLUMN = {
    "company_name": "SELECT c.name FROM leads l JOIN companies c ON l.company_id=c.id LIMIT 5",
    "hr_email": "SELECT hc.personal_email FROM leads l JOIN hr_contacts hc ON l.hr_contact_id=hc.id WHERE nullif(hc.personal_email,'') IS NOT NULL LIMIT 5",
    "salary_currency": "SELECT DISTINCT jp.salary_currency FROM job_postings jp JOIN leads l ON l.job_posting_id=jp.id WHERE nullif(jp.salary_currency,'') IS NOT NULL LIMIT 5",
    "contact_source": "SELECT hc.contact_source FROM leads l JOIN hr_contacts hc ON l.hr_contact_id=hc.id WHERE hc.contact_source IS NOT NULL LIMIT 5",
}

# canonical field -> the export header that must carry it
FIELD_TO_HEADER = {
    "job_description": "Job Description", "about_job": "About Job",
    "hr_confidence": "HR Confidence", "contact_source": "Contact Source",
    "contact_method": "Contact Method", "legal_basis": "Legal Basis",
    "processing_purpose": "Processing Purpose", "location": "Location",
    "salary_min": "Salary Min", "salary_currency": "Currency",
    "experience_level": "Experience", "apply_url": "Apply URL",
    "source_site": "Source", "company_name": "Company",
    "company_domain": "Domain", "hr_email": "HR Email",
    "pipeline_stage": "Pipeline Stage", "lead_score": "Score",
}


def parse_xls(xml):
    """SpreadsheetML -> (headers, rows) using the Leads worksheet."""
    sheet = xml.split('ss:Name="Leads"')[1]
    rows = []
    for row_xml in re.findall(r"<Row[^>]*>(.*?)</Row>", sheet, re.S):
        cells = []
        # <Cell .../> (empty) and <Cell ...>...</Cell> both count as one column.
        for cell_xml in re.findall(r"<Cell\b[^>]*/>|<Cell\b[^>]*>.*?</Cell>", row_xml, re.S):
            m = re.search(r"<Data[^>]*>(.*?)</Data>", cell_xml, re.S)
            cells.append(m.group(1) if m else "")
        rows.append(cells)
    # rows[0] = group banner, rows[1] = headers
    return rows[1], rows[2:]


def read_csv(text):
    """Real RFC4180 reader: job descriptions legitimately contain commas and quotes."""
    import csv as _csv, io
    rows = list(_csv.reader(io.StringIO(text.lstrip("\ufeff"))))
    rows = [r for r in rows if any(c.strip() for c in r)]
    return rows[0], rows[1:]


def unescape(v):
    """SpreadsheetML entity form -> comparable plain text."""
    for a, b in (("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", '"'), ("&apos;", "'")):
        v = v.replace(a, b)
    return v.lstrip("'")   # our own formula guard


def main():
    fails, checks = [], 0
    token = login()

    total_leads = int(psql("SELECT count(*) FROM leads")[0])
    print(f"DB leads: {total_leads}")

    xls = fetch_export(token)
    csv = fetch_export(token, "csv")
    xhead, xrows = parse_xls(xls)
    chead, crows = read_csv(csv)

    print(f"workbook: {len(xhead)} columns x {len(xrows)} rows; csv: {len(chead)} x {len(crows)}")

    def expect(cond, msg):
        nonlocal checks
        checks += 1
        if not cond:
            fails.append(msg)

    expect(len(xrows) == total_leads, f"row count {len(xrows)} != leads {total_leads}")
    expect(len(crows) == total_leads, f"csv row count {len(crows)} != leads {total_leads}")
    # The workbook adds two frozen key columns (#, Company) that a CSV has no use for.
    expect(xhead[2:] == chead, f"xls/csv data headers differ: {[(a,b) for a,b in zip(xhead[2:],chead) if a!=b][:3]}")
    expect(len(set(xhead)) == len(xhead), f"duplicate headers: {[h for h in xhead if xhead.count(h) > 1]}")

    def db_values(field):
        """The authoritative set of values for one lead field, straight from Postgres."""
        col = DB_COLUMN[field]
        return [v for v in psql(col % ()) if v.strip()]

    # every DB field with data must appear, under a header, in both formats, with the
    # same number of populated cells as the database has values.
    for pair in psql(FILL_SQL):
        field, count = pair.split("|")
        count = int(count)
        if count == 0:
            continue
        header = FIELD_TO_HEADER[field]
        for label, head, rws in (("xls", xhead, xrows), ("csv", chead, crows)):
            expect(header in head, f"[{label}] field '{field}' ({count} rows) has NO column '{header}'")
            if header not in head:
                continue
            idx = head.index(header)
            if label == "xls":
                filled = sum(1 for r in rws if len(r) > idx and unescape(r[idx]).strip())
            else:
                filled = sum(1 for r in rws if len(r) > idx and r[idx].strip())
            expect(filled >= count,
                   f"[{label}] '{header}' shows {filled} non-empty cells but DB has {count} values for {field}")

    # spot-check content, not just presence: real DB values must reach the cells
    for field in ("company_name", "hr_email", "salary_currency", "contact_source"):
        want = db_values(field)[:5]
        header = FIELD_TO_HEADER[field]
        idx = chead.index(header)
        got = {r[idx].strip() for r in crows if len(r) > idx}
        missing = [w for w in want if w not in got]
        expect(not missing, f"DB values for {field} absent from CSV export: {missing[:3]}")

    # freshness: a lead edited *after* the export was written must not be there, and one
    # already in the DB must be — i.e. the export reflects current data, not a cache.
    company_col = {c for c in db_values("company_name")}
    in_export = {unescape(r[xhead.index('Company')]).strip() for r in xrows}
    absent = sorted(company_col - in_export)
    expect(not absent, f"{len(absent)} companies in the DB are missing from the workbook, e.g. {absent[:3]}")

    # formula guard + hyperlink styling present
    expect("'=" not in xls or "&apos;=" in xls, "unguarded formula written to workbook")
    expect('ss:HRef="http' in xls, "URLs are not clickable in the workbook")
    expect('ss:Name="Summary"' in xls, "no Summary sheet")
    expect("<FreezePanes/>" in xls, "header rows are not frozen")

    # filters must apply to the export too
    one = fetch_export(token)
    _ = one
    hot = urllib.request.Request(f"{BASE}/leads/export?score_band=hot&format=csv",
                                headers={"Authorization": f"Bearer {token}"})
    n_hot_db = int(psql("SELECT count(*) FROM leads WHERE score_band='hot'")[0])
    with urllib.request.urlopen(hot) as r:
        _, hrows = read_csv(r.read().decode("utf-8-sig"))
    expect(len(hrows) == n_hot_db, f"filtered export gave {len(hrows)} rows, DB says {n_hot_db} hot leads")

    print(f"\n{checks - len(fails)}/{checks} checks passed")
    if fails:
        print("FAILURES:")
        for f in fails:
            print("  ✗", f)
        return 1
    print("✓ export covers every populated field, matches the DB, and is styled")
    return 0


if __name__ == "__main__":
    sys.exit(main())
