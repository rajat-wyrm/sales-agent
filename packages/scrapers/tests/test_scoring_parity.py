"""The TS and Python scorers must produce identical output.

Two implementations of the same rubric exist because workers recompute scores on
write (scrapers/api_utils/scoring_client.py) while the API recomputes them on
demand (/api/leads/:id/score, api/src/utils/scoring.ts). When they disagree, a
lead's band flips depending on which code path last touched it -- the CRM shows
one number and the dashboard aggregate another. These cases pin the agreement.

Run: python -m pytest tests/test_scoring_parity.py
Requires node on PATH; skipped otherwise so the suite stays runnable anywhere.
"""
import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scrapers.api_utils.scoring_client import calculate_score  # noqa: E402

REPO = Path(__file__).resolve().parents[3]
CASES = [
    {"salary_range": "8-12 LPA", "job_description": "x" * 200, "job_url": "u",
     "location": "Pune", "location_type": "hybrid", "department": "Eng", "openings_count": 3},
    {"salary_range": None, "job_description": "short", "job_url": None,
     "location": None, "location_type": None, "department": None, "openings_count": None},
    {"job_description": "y" * 150, "location": "Delhi"},
    {"salary_range": "5 LPA", "job_url": "u", "openings_count": 2},
    {"hr_name": "A", "hr_personal_email": "a@b.c", "email_status": "valid",
     "whatsapp_status": "registered", "location": "Chennai", "job_description": "z" * 300},
    {"hr_name": "B", "company_default_email": "c@d.com", "job_description": "q" * 400,
     "location": "Mumbai", "location_type": "remote", "department": "Sales", "openings_count": 5},
    {"job_url": "https://only/a/url", "posted_at": "2026-01-01"},
]


@pytest.mark.skipif(shutil.which("npx") is None, reason="node/npx not available")
def test_typescript_and_python_scores_match():
    script = """
import { calculateLeadScore } from './src/utils/scoring';
const cases = CASES_JSON;
const out = cases.map((c) => { const r = calculateLeadScore(c); return { score: r.score, jq: r.breakdown.job_quality?.points ?? 0 }; });
process.stdout.write(JSON.stringify(out));
"""
    api = REPO / "packages" / "api"
    # Must live inside packages/api: a scratch file elsewhere cannot resolve the
    # relative './src/utils/scoring' import, and a silently-skipped parity test
    # would prove nothing.
    p = api / "__parity_tmp.ts"
    try:
        p.write_text(script.replace("CASES_JSON", json.dumps(CASES)))
        proc = subprocess.run(["npx", "tsx", p.name], cwd=api,
                              capture_output=True, text=True, timeout=240)
        assert proc.returncode == 0, f"tsx failed: {proc.stderr[-400:]}"
        ts = json.loads(proc.stdout.strip().splitlines()[-1])
    finally:
        p.unlink(missing_ok=True)

    py = [{"score": int(calculate_score(c)["score"]),
           "jq": int(calculate_score(c).get("breakdown", {}).get("job_quality", {}).get("points", 0))}
          for c in CASES]

    assert len(ts) == len(py)
    for i, (a, b) in enumerate(zip(ts, py)):
        assert a == b, f"case {i} diverged: TS={a} PY={b} input={CASES[i]}"


def test_job_quality_follows_the_srs_rubric():
    """SRS §5.1: salary +3, full JD +4, valid job_url +3, capped at +10."""
    full = calculate_score({"salary_range": "8 LPA", "job_description": "d" * 500, "job_url": "u"})
    assert full["breakdown"]["job_quality"]["points"] == 10
    partial = calculate_score({"job_description": "d" * 500})
    assert partial["breakdown"]["job_quality"]["points"] == 4


def test_extra_facets_do_not_change_the_score():
    """Location/workplace are surfaced in the UI but are NOT scoring signals per
    the spec; asserting this keeps a future edit from silently rebalancing bands."""
    base = {"salary_range": "5 LPA", "job_url": "u"}
    enriched = dict(base, location="Pune", location_type="hybrid",
                    department="Eng", openings_count=9)
    assert calculate_score(base)["score"] == calculate_score(enriched)["score"]


def test_bare_posting_scores_zero_on_job_quality():
    r = calculate_score({"job_description": "too short"})
    assert r["breakdown"].get("job_quality", {}).get("points", 0) == 0
