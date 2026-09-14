"""Email provider routing for send_email().

Real defects this covers, all found by calling the live vendor APIs:
- The Resend URL was api.resend.email/v1/emails/send, a host that does not
  resolve; sending could never work no matter which key was pasted.
- Any key that did not start with "key-" was offered to Brevo, so a Resend key
  burned an extra request and the failure was reported as provider="unknown".
- Brevo authenticates with an `api-key` header (it answers "Key not found");
  the code sent `Authorization: Bearer`, which returns "token is invalid" even
  for a valid key.
"""
import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scrapers.send_worker import send_email  # noqa: E402


def _run(key):
    return asyncio.run(send_email(
        "recipient@example.com", "Subject", "Body", key, "leads@hiregen.ai"))


@pytest.mark.parametrize("key", ["", None, "garbage", "re", "brevo_but_wrong_shape"])
def test_unrecognised_key_is_blocked_not_sent(key):
    """No silent network attempt against a vendor we cannot authenticate to."""
    r = _run(key)
    assert r["status"] == "blocked"
    assert r["raw"]["error"] == "email_provider_not_configured"


def test_resend_key_routes_to_resend(monkeypatch):
    seen = {}

    class FakeResp:
        status_code = 400
        text = '{"message":"API key is invalid"}'

    class FakeClient:
        def __init__(self, **kw): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return False
        async def post(self, url, headers=None, json=None, **kw):
            seen["url"] = url
            seen["auth"] = {k.lower(): v for k, v in (headers or {}).items()}
            return FakeResp()

    monkeypatch.setattr("httpx.AsyncClient", FakeClient)
    r = _run("re_valid_looking_key")
    assert r["provider"] == "resend"
    assert seen["url"] == "https://api.resend.com/api/emails", \
        "api.resend.email does not resolve; the real host is api.resend.com"
    assert "authorization" in seen["auth"]


def test_brevo_key_uses_api_key_header(monkeypatch):
    seen = {}

    class FakeResp:
        status_code = 401
        text = '{"message":"Key not found"}'

    class FakeClient:
        def __init__(self, **kw): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return False
        async def post(self, url, headers=None, json=None, **kw):
            seen["url"] = url
            seen["headers"] = headers or {}
            return FakeResp()

    monkeypatch.setattr("httpx.AsyncClient", FakeClient)
    r = _run("keysib-deadbeef")
    assert r["provider"] == "brevo"
    assert seen["url"] == "https://api.brevo.com/v3/smtpEmail"
    # Documented auth: `api-key` header, NOT a bearer token.
    assert seen["headers"].get("api-key") == "keysib-deadbeef"
    assert "Authorization" not in seen["headers"]


def test_resend_success_reports_message_id(monkeypatch):
    class FakeResp:
        status_code = 200
        text = ""
        def json(self): return {"id": "rm_123", "to": ["recipient@example.com"]}

    class FakeClient:
        def __init__(self, **kw): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return False
        async def post(self, url, headers=None, json=None, **kw): return FakeResp()

    monkeypatch.setattr("httpx.AsyncClient", FakeClient)
    r = _run("re_good_key")
    assert r["status"] == "sent"
    assert r["provider"] == "resend"
    assert r["provider_message_id"] == "rm_123"


def test_a_resend_key_is_never_offered_to_brevo(monkeypatch):
    calls = []

    class FakeResp:
        status_code = 400
        text = "{}"

    class FakeClient:
        def __init__(self, **kw): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return False
        async def post(self, url, headers=None, json=None, **kw):
            calls.append(url)
            return FakeResp()

    monkeypatch.setattr("httpx.AsyncClient", FakeClient)
    _run("re_only_resend")
    assert all("brevo" not in u for u in calls), f"Resend key leaked to Brevo: {calls}"
