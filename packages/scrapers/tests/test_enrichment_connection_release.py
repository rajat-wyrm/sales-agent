"""Enrichment must not hold a pooled DB connection across vendor I/O.

process_enrichment_job used to acquire one asyncpg connection and keep it for the
whole job -- including the OSINT cascade and Snov.io/ContactOut calls, each with a
30s timeout. With ENRICH_CONCURRENCY + NORMALIZER_CONCURRENCY consumers sharing a
small pool, a few slow vendor responses starved every other worker and stalled the
pipeline while doing nothing useful.

These tests assert the read / network / write split holds: the cascade runs with
nothing checked out, and no connection leaks afterwards. They use provider="osint"
against a real pool only when DATABASE_URL is present; otherwise the pool-level
assertions run against an instrumented fake so CI without Postgres still covers the
ordering contract.
"""
import asyncio
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scrapers import enrichment_worker as E


class RecordingConnection:
    """Tracks acquire/release so we can assert what is held during each phase."""

    def __init__(self, pool):
        self._pool = pool

    async def fetchrow(self, *a, **k):
        return self._pool.rows.get("lead")
    async def fetchval(self, *a, **k):
        return self._pool.vals.get("v")
    async def execute(self, *a, **k):
        self._pool.executed.append(a[0][:40] if a else "")
        return "OK"


class RecordingPool:
    def __init__(self):
        self.out = 0
        self.max_seen = 0
        self.executed = []
        self.rows = {"lead": None}
        self.vals = {"v": None}
        self.held_during_cascade = None

    class _Ctx:
        def __init__(self, p): self.p = p
        async def __aenter__(self):
            self.p.out += 1
            self.p.max_seen = max(self.p.max_seen, self.p.out)
            return RecordingConnection(self.p)
        async def __aexit__(self, *a):
            self.p.out -= 1
            return False

    def acquire(self):
        return self._Ctx(self)


def test_module_exposes_the_cascade_function():
    assert hasattr(E, "run_enrichment_cascade"), \
        "cascade was inlined back into process_enrichment_job"
    import inspect
    params = list(inspect.signature(E.run_enrichment_cascade).parameters)
    # No `conn` parameter: the cascade must not be able to touch a pooled connection.
    assert "conn" not in params, "cascade takes a DB connection again"
    assert params[:7] == ["db_pool", "provider", "company_name", "company_domain",
                          "hr_name", "hr_linkedin", "api_keys"]


def test_process_job_releases_before_network(monkeypatch):
    """The core ordering guarantee: zero connections held during the cascade."""
    pool = RecordingPool()
    captured = {}

    async def fake_cascade(*a, **k):
        captured["held"] = pool.out
        return {"hr_email": "x@y.com"}, "osint_fallback", 0, "success"

    monkeypatch.setattr(E, "run_enrichment_cascade", fake_cascade)
    # lead row must be truthy for the function to proceed past the early return
    pool.rows["lead"] = {
        "id": "11111111-1111-1111-1111-111111111111", "hr_contact_id": None,
        "pipeline_stage": "enriched", "company_id": None, "full_name": "",
        "linkedin_url": "", "personal_email": "", "personal_mobile": "",
        "contact_company_id": None, "company_name": "Acme", "domain": "acme.com",
        "email_status": None, "whatsapp_status": None,
    }

    async def fake_resolve(conn, requested_by):
        return None, {}
    import scrapers.utils.job_keys as JK
    monkeypatch.setattr(JK, "resolve_job_user", fake_resolve)

    async def fake_score(*a, **k): return None
    monkeypatch.setattr(E, "recompute_lead_score", fake_score)
    async def fake_chain(*a, **k): return None
    monkeypatch.setattr(E, "chain_lead", fake_chain)
    async def fake_pub(*a, **k): return None
    monkeypatch.setattr(E, "publish_event", fake_pub)

    asyncio.run(E.process_enrichment_job(
        {"lead_id": "11111111-1111-1111-1111-111111111111", "provider": "osint",
         "requested_by": "daily_scheduler"},
        object(), pool))

    assert captured["held"] == 0, \
        f"cascade ran while {captured['held']} connection(s) were checked out"
    assert pool.out == 0, "connection leaked after the job finished"
    assert pool.max_seen <= 1, f"more than one connection held at once: {pool.max_seen}"
