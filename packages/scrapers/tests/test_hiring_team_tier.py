"""Tier-0 hiring-team discovery regression test.

A lead with no HR name must still get a hiring contact discovered (not leave
with nothing): run_osint_enrichment should consult extract_hr_for_company and
adopt the discovered name so the name-gated tiers below can run. Every network
surface is stubbed — this test never leaves the box.
"""
import asyncio
from typing import Any, cast
from unittest.mock import patch

from scrapers.enrichment_worker import run_osint_enrichment

NO_POOL = cast(Any, None)


def _run(coro):
    return asyncio.run(coro)


async def _fake_extract(company, domain, job_url=""):
    assert company == "Acme"
    return {
        "hr_name": "Priya Sharma",
        "hr_email": "",
        "hr_linkedin": "https://www.linkedin.com/in/priya-sharma-hr",
        "source": "career_page",
        "confidence": 0.8,
    }


async def _empty(*a, **k):
    return {}


async def _empty_list(*a, **k):
    return []


def _isolated():
    """Stub every network surface run_osint_enrichment can touch."""
    return (
        patch("scrapers.utils.linkedin_osint.resolve_linkedin_profile", side_effect=_empty),
        patch("scrapers.utils.github_email_osint.github_company_contacts", side_effect=_empty),
        patch("scrapers.utils.osint.osint_find_email", side_effect=_empty),
        patch("scrapers.utils.serp_dork.dork_find_email", side_effect=_empty),
        patch("scrapers.utils.osint_contacts.crtsh_emails", side_effect=_empty_list),
        patch("scrapers.utils.osint_contacts.wayback_emails", side_effect=_empty_list),
        patch("scrapers.utils.osint_contacts.gravatar_lookup", side_effect=_empty),
        patch("scrapers.utils.rss_signals.fetch_company_hiring_signals", side_effect=_empty),
        patch("scrapers.normalizer.run_holehe_check", side_effect=_empty),
        patch("scrapers.utils.email_providers.paid_email_waterfall", side_effect=_empty),
    )


def test_nameless_lead_gets_hiring_contact():
    patches = _isolated()
    with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5], patches[6], patches[7], patches[8], patches[9]:
        with patch(
            "scrapers.utils.company_hr_extractor.extract_hr_for_company",
            side_effect=_fake_extract,
        ):
            res = _run(run_osint_enrichment(NO_POOL, "Acme", "", "acme.com", {}))
    assert res.get("hr_name") == "Priya Sharma", res
    assert res.get("hr_linkedin_url") == "https://www.linkedin.com/in/priya-sharma-hr"
    assert str(res.get("method", "")).startswith("hiring_team:")


def test_named_lead_skips_discovery():
    async def _boom(*a, **k):
        raise AssertionError("Tier-0 must not run when hr_name is present")

    patches = _isolated()
    with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5], patches[6], patches[7], patches[8], patches[9]:
        with patch(
            "scrapers.utils.company_hr_extractor.extract_hr_for_company",
            side_effect=_boom,
        ):
            res = _run(run_osint_enrichment(NO_POOL, "Acme", "Ravi", "acme.com", {}))
    assert "hiring_team" not in str(res.get("method", ""))


if __name__ == "__main__":
    test_nameless_lead_gets_hiring_contact()
    test_named_lead_skips_discovery()
    print("hiring-team tier OK")
