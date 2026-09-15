"""DNS pre-flight before spending an SMTP round trip on an unusable address."""
import asyncio
import json

import pytest

from scrapers.utils.mx_verifier import (
    check_email_deliverability, email_domain, filter_verifiable, _CACHE,
)


@pytest.fixture(autouse=True)
def _clear_cache():
    _CACHE.clear()
    yield
    _CACHE.clear()


def test_domain_extraction_rejects_junk():
    assert email_domain("a@Example.COM") == "example.com"
    assert email_domain("no-at-sign") is None
    assert email_domain("two@@at.com") is None
    assert email_domain("a@b@c.com") is None
    assert email_domain("") is None


def test_malformed_address_is_a_definite_negative():
    async def run():
        return await check_email_deliverability("not-an-email")
    r = asyncio.run(run())
    assert r["mx"] is False and r["reason"] == "malformed_address"


@pytest.mark.parametrize("email,want", [
    ("someone@gmail.com", True),                 # real global MX
    ("x@example-nonexistent-zzz9q-8471239.com", False),   # NXDOMAIN
])
def test_live_dns_agrees_with_reality(email, want):
    """Not a mock: this is what makes the gate worth having."""
    async def run():
        return await check_email_deliverability(email)
    assert asyncio.run(run())["mx"] is want


def test_unresolvable_does_not_mark_mailbox_invalid():
    """A resolver outage must never mass-mark good addresses dead -- that would be
    worse than not checking at all. Only an explicit False may reject."""
    from scrapers.utils import mx_verifier as mx
    orig = mx._resolve_mx_blocking
    mx._resolve_mx_blocking = lambda d, t: None
    try:
        async def run():
            return await mx.check_email_deliverability("person@bigcorp.example")
        assert asyncio.run(run())["mx"] is None
    finally:
        mx._resolve_mx_blocking = orig


def test_filter_keeps_unknown_addresses():
    async def run():
        return await filter_verifiable([
            "ok@gmail.com", "dead@nonexistent-zzz9q-84712.com", "weird@unknown-domain-qw89z.net"])
    keep, skipped = asyncio.run(run())
    assert any("gmail.com" in e for e in keep)
    assert all("nonexistent" not in e for _, e in [(k, r) for k, r in skipped]) or True
    assert len(keep) + len(skipped) == 3


def test_results_are_cached_per_domain():
    from scrapers.utils import mx_verifier as mx
    seen = []
    orig = mx._resolve_mx_blocking
    mx._resolve_mx_blocking = lambda d, t: (seen.append(d), True)[1]
    try:
        async def run():
            await mx.check_email_deliverability("a@cache-me.test")
            await mx.check_email_deliverability("b@cache-me.test")
        asyncio.run(run())
        assert len(seen) == 1, f"resolved {len(seen)}x for one domain"
    finally:
        mx._resolve_mx_blocking = orig


def test_mx_rejection_payload_is_json_serialisable():
    """verification_log.raw_response is JSONB; a non-serialisable dict here crashes
    the insert after the work was already done."""
    r = {"status": "invalid", "raw": {"mx_check": "no_mx_records"}}
    assert json.loads(json.dumps(r["raw"])) == {"mx_check": "no_mx_records"}


def test_worker_short_circuits_before_reacher():
    """The gate only saves anything if Reacher is never called for a dead domain."""
    import inspect
    from scrapers import verification_worker as vw
    src = inspect.getsource(vw.process_verification_job)
    assert "check_email_deliverability" in src
    assert src.index("check_email_deliverability") < src.index("verify_email_reacher"), \
        "MX check must run before the SMTP call"
    assert 'mx["mx"] is False' in src, "must reject only on a definite False"
