#!/usr/bin/env python3
"""
Verify CSV import + automatic dedup against the live database.

The promise is: paste any CSV with the same fields and nothing duplicates. Three cases,
in order, each checked at SQL level rather than by trusting the response body:

  A. re-import our own export        -> every row merges, lead count unchanged
  B. import a synthetic new list     -> rows are created
  C. import that same list again     -> all merge, lead count back to where B left it
  D. third-party headers / junk rows -> mapped or skipped with a reason, never 500
"""
import io
import json
import os
import subprocess
import sys
import urllib.request
import uuid

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


def post(path, token, body):
    req = urllib.request.Request(
        f"{BASE}{path}", data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
    )
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "{}")


def get_text(path, token):
    req = urllib.request.Request(f"{BASE}{path}", headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req) as r:
        return r.read().decode("utf-8-sig")


def psql(sql):
    out = subprocess.run(
        ["docker", "compose", "exec", "-T", DB_SERVICE, "psql", "-U", DB_USER,
         "-d", DB_NAME, "-t", "-A", "-c", sql],
        capture_output=True, text=True, cwd=REPO,
    )
    if out.returncode:
        raise RuntimeError(out.stderr)
    return out.stdout.strip()


FAILS = []


def check(cond, msg):
    if cond:
        print(f"  ✓ {msg}")
    else:
        print(f"  ✗ {msg}")
        FAILS.append(msg)


def main():
    token = login()
    n0 = int(psql("SELECT count(*) FROM leads"))
    fp0 = int(psql("SELECT count(*) FROM job_postings"))
    print(f"baseline: {n0} leads, {fp0} job_postings\n")

    # ---- A. our own export must import straight back with zero new rows -------------
    print("A. re-import of our own export (dedup must collapse everything)")
    csv = get_text("/leads/export?format=csv", token)
    status, dry = post("/leads/import", token, {"csv": csv, "dry_run": True})
    check(status == 200, f"dry run accepted (HTTP {status})")
    print(f"   dry-run plan: {json.dumps({k: dry[k] for k in ('total_rows','created','merged','merged_fuzzy','skipped')})}")
    status, res = post("/leads/import", token, {"csv": csv})
    print(f"   committed:    {json.dumps({k: res[k] for k in ('total_rows','created','merged','merged_fuzzy','skipped')})}")
    n1 = int(psql("SELECT count(*) FROM leads"))
    fp1 = int(psql("SELECT count(*) FROM job_postings"))
    check(res.get("skipped", 99) == 0, f"no rows lost to errors ({res.get('errors', [])[:1]})")
    check(n1 == n0, f"lead count unchanged after re-import ({n0} -> {n1})")
    check(fp1 == fp0, f"job_posting count unchanged ({fp0} -> {fp1})")
    dup_sql = """SELECT count(*) FROM (
      SELECT jp.fingerprint FROM leads l JOIN job_postings jp ON l.job_posting_id=jp.id
      GROUP BY jp.fingerprint HAVING count(*) > 1) d"""
    check(int(psql(dup_sql)) == 0, "no lead shares a fingerprint with another lead")
    orphan = int(psql("""SELECT count(*) FROM job_postings jp LEFT JOIN leads l ON l.job_posting_id=jp.id WHERE l.id IS NULL AND jp.raw_payload->>'import_source' IS NOT NULL"""))
    check(orphan == 0, f"no imported posting without a lead ({orphan})")

    # ---- B/C. synthetic third-party file: create once, merge on repeat --------------
    tag = uuid.uuid4().hex[:8]
    print(f"\nB. import synthetic agency file (tag {tag})")
    header = "Company Name,Job Title,Job Location,CTC,E-mail,Phone,Linkedin Profile,Source"
    rows = [f'ImportCo {tag} {i},Engineer {i},"Bengaluru, KA","₹{12+i} LPA",person{i}@imp{tag}.com,+9198{i:08d},https://linkedin.com/in/imp{tag}{i},agency_sheet'
            for i in range(1, 7)]
    body = "\r\n".join([header] + rows) + "\r\n"
    status, res_b = post("/leads/import", token, {"csv": body})
    print(f"   first import: {json.dumps({k: res_b[k] for k in ('total_rows','created','merged','skipped')})}")
    check(status == 200 and res_b["created"] == 6, "6 new leads created")
    n2 = int(psql("SELECT count(*) FROM leads"))
    check(n2 == n1 + 6, f"DB grew by exactly 6 ({n1} -> {n2})")

    cols = psql(f"""SELECT count(*) FROM leads l JOIN companies c ON c.id=l.company_id
                    JOIN job_postings jp ON jp.id=l.job_posting_id
                    LEFT JOIN hr_contacts hc ON hc.id=l.hr_contact_id
                    WHERE c.name LIKE 'ImportCo {tag}%'
                      AND hc.personal_email LIKE '%imp{tag}%'
                      AND nullif(jp.salary_range,'') IS NOT NULL
                      AND jp.location_type='remote' OR false""")
    detail = psql(f"""SELECT concat_ws('/',
        count(*) FILTER (WHERE true),
        count(*) FILTER (WHERE hc.personal_email IS NOT NULL),
        count(*) FILTER (WHERE hc.personal_mobile IS NOT NULL),
        count(*) FILTER (WHERE nullif(jp.salary_range,'') IS NOT NULL),
        count(*) FILTER (WHERE nullif(jp.location,'') IS NOT NULL),
        count(*) FILTER (WHERE l.lead_score > 0))
      FROM leads l JOIN companies c ON c.id=l.company_id
      JOIN job_postings jp ON jp.id=l.job_posting_id
      LEFT JOIN hr_contacts hc ON hc.id=l.hr_contact_id
      WHERE c.name LIKE 'ImportCo {tag}%'""").split("/")
    check(detail[0] == "6", f"all 6 leads readable via company join (got {detail[0]})")
    check(detail[1] == "6" and detail[2] == "6", "HR email + mobile landed on the contact")
    check(detail[3] == "6", "'CTC' header mapped into salary_range")
    check(detail[4] == "6", "'Job Location' header mapped into location")
    check(detail[5] == "6", "imported leads were scored (lead_score > 0), not left at 0/cold")

    stage = psql(f"SELECT DISTINCT l.pipeline_stage FROM leads l JOIN companies c ON c.id=l.company_id WHERE c.name LIKE 'ImportCo {tag}%'")
    check(stage == "discovered", f"new imports start at 'discovered' (got '{stage}')")

    print("\nC. import the SAME file again (the no-duplication guarantee)")
    status, res_c = post("/leads/import", token, {"csv": body})
    print(f"   second import: {json.dumps({k: res_c[k] for k in ('total_rows','created','merged','merged_fuzzy','skipped')})}")
    n3 = int(psql("SELECT count(*) FROM leads"))
    co3 = int(psql(f"SELECT count(*) FROM companies WHERE name LIKE 'ImportCo {tag}%'"))
    hc3 = int(psql(f"SELECT count(*) FROM hr_contacts hc WHERE hc.current_company_id IN (SELECT id FROM companies WHERE name LIKE 'ImportCo {tag}%')"))
    check(res_c["created"] == 0, "second pass created nothing")
    check(res_c["merged"] == 6, f"all 6 merged instead ({res_c['merged']})")
    check(n3 == n2, f"lead count stable ({n2} -> {n3})")
    check(co3 == 6, f"no duplicate company rows ({co3})")
    check(hc3 == 6, f"no duplicate contact rows ({hc3})")

    # fill-only-blank: an import must never overwrite what already exists
    before = psql(f"SELECT min(jp.title) FROM job_postings jp JOIN companies c ON c.id=jp.company_id WHERE c.name LIKE 'ImportCo {tag}%'")
    status, _ = post("/leads/import", token, {"csv": "\r\n".join([header, rows[0].replace(",Engineer 1,", ",WILL-NOT-OVERWRITE,")]) + "\r\n"})
    after = psql(f"SELECT min(jp.title) FROM job_postings jp JOIN companies c ON c.id=jp.company_id WHERE c.name LIKE 'ImportCo {tag}%'")
    check(before == after, f"existing title kept, not overwritten ('{before}' == '{after}')")

    # ---- D. malformed input ---------------------------------------------------------
    print("\nD. bad input handling")
    st, r = post("/leads/import", token, {"csv": "not,a,known,header\n1,2,3,4\n"})
    check(st in (200, 400), f"unrecognised headers answered cleanly (HTTP {st})")
    check(st == 200 and r.get("skipped", 0) + r.get("total_rows", 0) >= 0 and not r.get("created"),
          "nothing invented from unknown columns")
    st, r = post("/leads/import", token, {})
    check(st == 400, f"empty body rejected with 400 (got {st})")
    st, r = post("/leads/import", token, {"csv": "Company\r\n"})
    check(st == 400, f"header-only file rejected with 400 (got {st})")
    st, r = post("/leads/import", token, {"csv": f'Company,Job Title,Job URL\r\nNoContact Co {tag},Analyst,https://nocontact{tag}.example/j1'})
    check(st == 200 and r.get("created") == 1,
          f"a company+role row with no contact still imports (HTTP {st}, {json.dumps(r.get('created', r))})")

    # unauthenticated must not import
    req = urllib.request.Request(f"{BASE}/leads/import", data=b'{"csv":"a\\nb"}', headers={"Content-Type": "application/json"})
    try:
        urllib.request.urlopen(req)
        check(False, "anonymous import was accepted")
    except urllib.error.HTTPError as e:
        check(e.code == 401, f"anonymous import rejected with 401 (got {e.code})")

    # cleanup the synthetic rows so repeated runs stay honest
    subprocess.run(["docker", "compose", "exec", "-T", DB_SERVICE, "psql", "-U", DB_USER,
                    "-d", DB_NAME, "-q", "-c",
                    f"DELETE FROM companies WHERE name LIKE 'ImportCo {tag}%'"], capture_output=True)
    n4 = int(psql("SELECT count(*) FROM leads"))
    print(f"\ncleanup: leads {n4} (was {n0} at start; +1 from the no-contact row above, cascaded with the company)")

    print(f"\n{'FAILED: ' + str(len(FAILS)) if FAILS else 'ALL IMPORT CHECKS PASSED'}")
    for f in FAILS:
        print("  -", f)
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
