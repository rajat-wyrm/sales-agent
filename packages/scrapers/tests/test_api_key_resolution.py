"""API-key resolution across the API/worker boundary.

Three separate defects made every configured provider unusable, each hidden by a
broad `except Exception: pass` in the workers:

1. decrypt_text() expected base64(iv || ciphertext || tag) but the API writes
   base64(iv || tag || ciphertext), so AES-GCM auth always failed (InvalidTag).
2. users.api_keys is jsonb holding JSON.stringify(...), i.e. double-encoded, so a
   single json.loads returned a str and callers treated it as "no keys".
3. Automated runs pass requested_by="daily_scheduler", which is not a UUID, so
   user_id became None and keys were never looked up at all -- paid providers
   worked only for manual clicks.

These are regression tests for exactly that wiring; they need no network.
"""
import asyncio
import base64
import hashlib
import json
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# Async helpers are driven with asyncio.run() so this file needs no plugin config.


from scrapers.crypto_utils.decrypt import decrypt_text  # noqa: E402
from scrapers.utils.job_keys import _as_dict, resolve_job_user  # noqa: E402


def _node_style_blob(plaintext: str) -> str:
    """Encrypt exactly as packages/api/src/utils/crypto.ts encryptText() does:
    base64(iv[12] || authTag[16] || ciphertext)."""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    key = hashlib.scrypt(
        os.environ["ENCRYPTION_SECRET"].encode(), salt=b"salt",
        n=16384, r=8, p=1, dklen=32,
    )
    iv = os.urandom(12)
    sealed = AESGCM(key).encrypt(iv, plaintext.encode(), None)  # cryptography returns ct||tag
    ct, tag = sealed[:-16], sealed[-16:]
    return base64.b64encode(iv + tag + ct).decode()


@pytest.fixture(autouse=True)
def _secret(monkeypatch):
    monkeypatch.setenv("ENCRYPTION_SECRET", "x" * 64)


def test_decrypt_reads_the_api_wire_format():
    assert decrypt_text(_node_style_blob("re_abcdefghijklmnop")) == "re_abcdefghijklmnop"


def test_decrypt_rejects_truncated_payload():
    short = base64.b64encode(os.urandom(10)).decode()
    with pytest.raises(ValueError):
        decrypt_text(short)


def test_as_dict_handles_double_encoded_jsonb():
    inner = {"snovio": "abc", "gemini": "def"}
    # what asyncpg hands back for a jsonb column written via JSON.stringify
    raw = json.dumps(json.dumps(inner))
    assert _as_dict(raw) == inner
    assert _as_dict(json.dumps(inner)) == inner   # single-encoded also works
    assert _as_dict(inner) == inner               # already a dict
    assert _as_dict(None) == {}
    assert _as_dict("") == {}
    assert _as_dict("not json") == {}
    assert _as_dict([1, 2]) == {}


class _FakeConn:
    """Minimal asyncpg stand-in: returns one admin row for the fallback query."""

    def __init__(self, api_keys):
        self._keys = api_keys
        self.calls = []

    async def fetchrow(self, query, *args):
        self.calls.append((query, args))
        if "role = 'admin'" in query or "api_keys, '{}'::jsonb" in query:
            return {"id": "owner-uuid", "api_keys": self._keys}
        return {"api_keys": self._keys}


def test_manual_run_uses_its_own_requester():
    blob = _node_style_blob("SNOV_REAL")
    conn = _FakeConn({"snovio": blob})
    uid, keys = asyncio.run(
        resolve_job_user(conn, "11111111-2222-3333-4444-555555555555"))
    assert uid == "11111111-2222-3333-4444-555555555555"
    assert keys == {"snovio": "SNOV_REAL"}


@pytest.mark.parametrize("sentinel", ["daily_scheduler", "system", None, "nonsense"])
def test_scheduled_run_still_gets_keys(sentinel):
    """The core bug: automated runs previously received an empty dict."""
    blob = _node_style_blob("GEM_REAL")
    conn = _FakeConn({"gemini": blob})
    uid, keys = asyncio.run(resolve_job_user(conn, sentinel))
    assert keys == {"gemini": "GEM_REAL"}
    # Attribution stays correct: a scheduled run must not be credited to a human.
    assert uid is None


def test_undecryptable_key_is_dropped_not_forwarded():
    conn = _FakeConn({"snovio": "not-a-real-ciphertext-blob"})
    uid, keys = asyncio.run(resolve_job_user(conn, "daily_scheduler"))
    assert keys == {}, "ciphertext must never be forwarded to a vendor as a key"


def test_no_users_at_all_yields_empty():
    class Empty(_FakeConn):
        async def fetchrow(self, query, *a):
            return None
    uid, keys = asyncio.run(resolve_job_user(Empty({}), "daily_scheduler"))
    assert (uid, keys) == (None, {})


def test_admin_with_keys_wins_over_other_users():
    """Fallback order matters: pick the admin, not an arbitrary sales_rep."""
    blob = _node_style_blob("RESEND_KEY")
    seen = []

    class Ordered:
        async def fetchrow(self, query, *a):
            seen.append(query)
            if "role = 'admin'" in query:
                return {"id": "adm", "api_keys": json.dumps({"resend": blob})}
            return {"id": "other", "api_keys": "{}"}
    uid, keys = asyncio.run(resolve_job_user(Ordered(), "daily_scheduler"))
    assert keys == {"resend": "RESEND_KEY"} and uid is None
    assert any("role = 'admin'" in q for q in seen), "admin should be tried first"
