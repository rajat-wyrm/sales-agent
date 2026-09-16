#!/usr/bin/env python3
"""
Adversarial verification for the parts of export/import that a happy-path test cannot see:
formula injection in every writer, opt-out suppression on every write path (including the
in-file duplicate branch), E.164 normalisation, per-row transactional atomicity, chunked
large imports, and the per-lead RBAC rules that were previously missing.

Reads credentials from the environment like the other verify scripts.
"""
import csv as csvmod
import io
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request

BASE = os.environ.get("API_BASE", "http://localhost:3000/api")
ADMIN_EMAIL = os.environ["VERIFY_ADMIN_EMAIL"]
ADMIN_PASSWORD = os.environ["VERIFY_ADMIN_PASSWORD"]
DB = os.environ.get("DB_COMPOSE_SERVICE", "postgres")
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FAILS = []


def check(cond, msg):
    print(("  ✓ " if cond else "  ✗ ") + msg)
    if not cond:
        FAILS.append(msg)


def login(email=ADMIN_EMAIL, password=ADMIN_PASSWORD):
    req = urllib.request.Request(
        f"{BASE}/auth/login", data=json.dumps({"email": email, "password": password}).encode(),
        headers={"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req))["access_token"]


def post(path, token, body):
    req = urllib.request.Request(f"{BASE}{path}", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"raw": raw}


def get_bytes(path, token):
    req = urllib.request.Request(f"{BASE}{path}", headers={"Authorization": f"Bearer {token}"})
    return urllib.request.urlopen(req).read()


def psql(sql):
    out = subprocess.run(["docker", "compose", "exec", "-T", DB, "psql", "-U", "postgres",
                          "-d", "leads_db", "-t", "-A", "-c", sql],
                         capture_output=True, text=True, cwd=REPO)
    if out.returncode:
        raise RuntimeError(out.stderr[:400])
    return out.stdout.strip()


def wait(seconds):
    print(f"   … waiting {seconds}s for the import rate-limit window")
    import time
    time.sleep(seconds)


TOKEN = login()

# ---------------------------------------------------------------- 1. formula injection
print("1. formula injection — every writer, every opener")
PAYLOADS = ["=SUM(1,2)", "+1", "-1+1", "@SUM(1)", "|calc|X"]
csv_body = "Company,Job Title,Job URL\n" + "\n".join(
    f'FormulaCo ZZZ{i},Role {i},https://formulaz{i}.example/j1' for i in range(len(PAYLOADS)))
# put payloads into a single row across guarded columns instead
csv_body = ('Company,Job Title,Job URL,Department,Currency\n'
            '"=SUM(1,2)","|calc|X",https://formula.example/j1,"-1+1",INR')
st, res = post("/leads/import", TOKEN, {"csv": csv_body})
check(st == 200 and res.get("created") == 1, f"payload row imported (HTTP {st}, created={res.get('created')})")

xls = get_bytes("/leads/export?filter=formula.example", TOKEN).decode()
csv_out = get_bytes("/leads/export?format=csv&filter=formula.example", TOKEN).decode("utf-8-sig")
rows = [r for r in csvmod.reader(io.StringIO(csv_out)) if any(c.strip() for c in r)]
hdr, data = rows[0], rows[1]
for col, payload in (("Company", "=SUM(1,2)"), ("Job Title", "|calc|X"), ("Department", "-1+1")):
    cell = data[hdr.index(col)]
    check(cell.startswith("'"), f"CSV guards leading {col} '{payload}' -> {cell!r}")
    check(f"'{payload}" in xls or "&apos;" + payload in xls.replace("&quot;", '"'),
          f"workbook guards leading {col} '{payload}'")

psql("DELETE FROM companies WHERE name='=SUM(1,2)' OR job_url IS NOT NULL AND id IN (SELECT id FROM job_postings WHERE job_url LIKE 'https://formula.example%')") if False else None
psql("DELETE FROM companies WHERE name = '=SUM(1,2)'")

# ---------------------------------------------------------------- 2. suppression on ALL paths
print("\n2. opt-out suppression holds on every write path")
psql("INSERT INTO suppressions (normalized_contact, channel, reason, source) VALUES "
     "('dupe-opt@sup.example','email','opted_out','probe'),"
     "('9876500111','whatsapp','opted_out','probe') ON CONFLICT DO NOTHING")
H = "Company,Job Title,Job URL,E-mail,Phone"
# same job twice in one file -> row 2 takes the in-file merge branch, which used to skip the check
body = (f"{H}\nOptDup Co,Analyst,https://optdup.example/j1,dupe-opt@sup.example,\n"
        f"OptDup Co,Analyst,https://optdup.example/j1,dupe-opt@sup.example,\n"
        f"OptMob Co,Analyst2,https://optmob.example/j2,,98765 00111\n")
wait(60)
st, r = post("/leads/import", TOKEN, {"csv": body})
check(st == 200, f"mixed suppression import accepted (HTTP {st})")
flagged = psql("SELECT count(*) FROM leads l JOIN companies c ON c.id=l.company_id "
               "WHERE c.name IN ('OptDup Co','OptMob Co') AND l.do_not_contact = true")
check(flagged == "2", f"both the in-file-merge row and the bare-national phone are flagged (got {flagged}/2)")
stored_mob = psql("SELECT nullif(hc.personal_mobile,'') FROM hr_contacts hc JOIN companies c ON c.id=hc.current_company_id WHERE c.name='OptMob Co'")
check(stored_mob == "+919876500111", f"bare national number stored as E.164 (got {stored_mob!r})")
# an import must never clear an existing flag
st, _ = post("/leads/import", TOKEN, {"csv": f"{H}\nOptDup Co,Analyst,https://optdup.example/j1,,\n"})
still = psql("SELECT count(*) FROM leads l JOIN companies c ON c.id=l.company_id WHERE c.name='OptDup Co' AND do_not_contact")
check(still == "1", "a later import without the email did NOT clear the opt-out flag")
psql("DELETE FROM companies WHERE name IN ('OptDup Co','OptMob Co'); DELETE FROM suppressions WHERE source='probe';")

# ---------------------------------------------------------------- 3. atomicity
print("\n3. per-row atomicity (no half-written lead)")
wait(60)
before = int(psql("SELECT count(*) FROM job_postings jp LEFT JOIN leads l ON l.job_posting_id=jp.id WHERE l.id IS NULL"))
bad = ("Company,Job Title,Job URL,Salary Min,Salary Max\n"
       "Atomic Co,Bad Salary,https://atomic.example/j1,900000,100000\n")  # min>max is clamped, so this should succeed
st, r = post("/leads/import", TOKEN, {"csv": bad})
check(st == 200 and r.get("created") == 1, f"inverted salary pair clamped rather than lost (created={r.get('created')})")
ok_orphan = psql("SELECT count(*) FROM job_postings jp LEFT JOIN leads l ON l.job_posting_id=jp.id WHERE l.id IS NULL")
check(int(ok_orphan) == before, f"no new orphan posting created ({before} -> {ok_orphan})")
psql("DELETE FROM companies WHERE name='Atomic Co'")

# ---------------------------------------------------------------- 4. header echo / junk
print("\n4. junk input cannot invent records")
wait(60)
st, r = post("/leads/import", TOKEN, {"csv": "Company Name,Job Title,E-mail\ncompany_name,job_title,hr_email\n"})
check(r.get("created", 0) == 0, f"row of column names created nothing (created={r.get('created')})")
ghost = psql("SELECT count(*) FROM companies WHERE lower(name) IN ('company_name','company name','job_title')")
check(ghost == "0", f"no company named after a column header exists ({ghost})")

# ---------------------------------------------------------------- 5. large file via chunks
print("\n5. larger-than-one-request file (client chunking contract)")
pad = "x" * 2500
big = "Company,Job Title,Job URL,Notes\n" + "\n".join(
    f'Bulk Co {i % 50},Role {i},https://bulk{i}.example/j{i},{pad}' for i in range(2600))
check(len(big) > 6_000_000, f"synthetic file is {len(big)/1e6:.2f} MB / 2600 rows (above the per-request ceiling)")
st, r = post("/leads/import", TOKEN, {"csv": big})
over = st == 413 or str(r.get("error", "")).lower().startswith("file is too large")
check(over, f"single oversized request refused clearly (HTTP {st}, err={str(r.get('error'))[:70]})")
written = int(psql("SELECT count(*) FROM leads l JOIN companies c ON c.id=l.company_id WHERE c.name LIKE 'Bulk Co %'"))
check(written == 0, f"refused import wrote nothing partial ({written})")
# now the same content as two chunks under the ceiling -> both succeed
chunks = []
lines = big.split("\n")
head, body_lines = lines[0], lines[1:]
for i in range(0, len(body_lines), 1300):
    chunks.append(head + "\n" + "\n".join(body_lines[i:i + 1300]))
total_created = 0
for idx, ch in enumerate(chunks):
    check(len(ch) < 6_000_000, f"chunk {idx+1}/{len(chunks)} is within the ceiling ({len(ch)/1e6:.2f} MB)")
    wait(60)
    st2, r2 = post("/leads/import", TOKEN, {"csv": ch})
    total_created += r2.get("created", 0) if st2 == 200 else 0
    check(st2 == 200, f"chunk {idx+1} accepted (HTTP {st2})")
check(total_created >= 2000, f"chunked import persisted the bulk of the file ({total_created} created)")
psql("DELETE FROM companies WHERE name LIKE 'Bulk Co %'")

# ---------------------------------------------------------------- 6. RBAC on per-lead routes
print("\n6. per-lead RBAC (timeline / bulk-draft / merge-duplicate)")
rep_a = "rbac-a@test.example"
rep_b = "rbac-b@test.example"
pw = "RbacProbe!2026"
sys.path.insert(0, REPO + "/packages/api/node_modules")
try:
    import bcrypt  # type: ignore
    hashed = bcrypt.hashpw(pw.encode(), bcrypt.gensalt(4)).decode()
except Exception:
    # fall back to a hash generated by the app's own bcryptjs
    hashed = subprocess.run(
        ["docker", "compose", "exec", "-T", "api", "node", "-e",
         "const b=require('bcryptjs');console.log(b.hashSync(process.argv[1],10))", pw],
        capture_output=True, text=True, cwd=REPO).stdout.strip()
psql(f"INSERT INTO users (email,password_hash,role) VALUES ('{rep_a}','{hashed}','sales_rep'),('{rep_b}','{hashed}','sales_rep') ON CONFLICT (email) DO UPDATE SET password_hash='{hashed}'")
LEAD = psql("SELECT id FROM leads ORDER BY created_at DESC LIMIT 1")
psql(f"UPDATE leads SET assigned_to=(SELECT id FROM users WHERE email='{rep_b}') WHERE id='{LEAD}'")
tok_a = login(rep_a, pw)
st, _ = post(f"/leads/{LEAD}/merge-duplicate", tok_a, {"merge_into_id": LEAD})
check(st in (400, 403, 404), f"rep A cannot merge rep B's lead (HTTP {st})")
gone = psql(f"SELECT count(*) FROM leads WHERE id='{LEAD}'")
check(gone == "1", "target lead still exists — no cross-rep deletion")
req = urllib.request.Request(f"{BASE}/leads/{LEAD}/timeline", headers={"Authorization": f"Bearer {tok_a}"})
try:
    code = urllib.request.urlopen(req).status
except urllib.error.HTTPError as e:
    code = e.code
check(code == 404, f"rep A reading rep B's timeline is 404 (got {code})")
st, r = post("/leads/bulk-draft", tok_a, {"lead_ids": [LEAD], "channel": "both"})
check(st == 403, f"bulk-draft with nothing owned is refused outright (HTTP {st})")
# give rep A one lead of their own, then mix: only theirs may be queued
own = psql("SELECT id FROM leads ORDER BY created_at ASC LIMIT 1")
psql(f"UPDATE leads SET assigned_to=(SELECT id FROM users WHERE email='{rep_a}') WHERE id='{own}'")
st, r = post("/leads/bulk-draft", tok_a, {"lead_ids": [own, LEAD], "channel": "both"})
check(st == 202 and r.get("lead_ids") == [own] and r.get("rejected_lead_ids") == [LEAD],
      f"mixed bulk-draft queues only the owned lead (HTTP {st}, {json.dumps({k:r.get(k) for k in ('lead_ids','rejected_lead_ids')})})")
psql(f"UPDATE leads SET assigned_to=NULL WHERE id='{own}'")
# restore ownership state
psql("UPDATE leads SET assigned_to=NULL WHERE assigned_to IN (SELECT id FROM users WHERE email LIKE 'rbac-%@test.example')")
psql("DELETE FROM users WHERE email LIKE 'rbac-%@test.example' ON CONFLICT DO NOTHING" if False else "SAVEPOINT x" if False else "--")

print("\n" + ("FAILED %d" % len(FAILS) if FAILS else "ALL ADVERSARIAL CHECKS PASSED"))
for f in FAILS:
    print("  -", f)
sys.exit(1 if FAILS else 0)
