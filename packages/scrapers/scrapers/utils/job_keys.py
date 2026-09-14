"""Resolve which user's API keys a pipeline job should use.

Every worker (enrichment, verification+send, send, draft) needs vendor keys, and
each had its own copy of "parse requested_by as a UUID, look that user up". That
shared assumption broke automated runs: the scheduler and army pass sentinels
("daily_scheduler", "system"), so the UUID parse failed, user_id became None, and
the job ran with NO keys -- meaning paid providers configured in Settings were
used only by manual clicks and never by the daily pipeline.

resolve_job_user() keeps the requesting user when there is one, and otherwise
falls back to an account that actually has keys, so pasting a key in Settings
takes effect on the next scheduled run without any restart or re-trigger.
"""
from __future__ import annotations

import json
import logging
import os
from typing import Any
from uuid import UUID

logger = logging.getLogger(__name__)


def _decrypt(value: str) -> str | None:
    """Decrypt a stored key. Returns None when it is not decryptable.

    A failed decrypt must NOT forward the ciphertext to a vendor as if it were a
    real key: that produces garbage auth failures and leaks a key-format oracle.
    """
    try:
        from ..crypto_utils.decrypt import decrypt_api_key
        return decrypt_api_key(value)
    except Exception:  # noqa: BLE001
        return None


def _is_uuid(value: Any) -> bool:
    if value is None:
        return False
    try:
        UUID(str(value))
        return True
    except (ValueError, TypeError, AttributeError):
        return False


def _as_dict(raw: Any) -> dict[str, str]:
    """Coerce a stored api_keys value into a dict.

    The column is jsonb, but the API writes JSON.stringify(...) into it, so asyncpg
    hands back a *string* that itself parses to another JSON string -- the object
    only appears after a second decode. A single json.loads was therefore returning
    a str, which callers dropped as {}, and no worker ever saw a key. Unwrap until
    we get a mapping (bounded, so pathological nesting cannot loop).
    """
    value = raw
    for _ in range(3):
        if isinstance(value, dict):
            return {k: v for k, v in value.items() if isinstance(v, str)}
        if isinstance(value, str) and value.strip():
            try:
                value = json.loads(value)
            except (ValueError, TypeError):
                return {}
            continue
        break
    return {}


async def resolve_job_user(conn, requested_by: Any) -> tuple[Any, dict[str, str]]:
    """Return (user_id, decrypted_api_keys) for one queued job.

    user_id stays None for sentinel requesters so log rows keep their FK valid;
    the keys still come from the fallback owner.
    """
    if _is_uuid(requested_by):
        uid = str(requested_by)
        row = await conn.fetchrow("SELECT api_keys FROM users WHERE id = $1", uid)
        stored = _as_dict(row["api_keys"] if row else None)
        keys = {k: d for k, v in stored.items()
                if isinstance(v, str) and (d := _decrypt(v)) is not None}
        return uid, keys

    # Automated run: prefer the admin, then any user holding keys. Ordering by
    # created_at keeps the choice stable across jobs instead of flapping.
    row = await conn.fetchrow(
        """SELECT id, api_keys FROM users
            WHERE role = 'admin' AND COALESCE(api_keys, '{}'::jsonb) <> '{}'::jsonb
            ORDER BY created_at LIMIT 1"""
    )
    if row is None:
        row = await conn.fetchrow(
            """SELECT id, api_keys FROM users
                WHERE COALESCE(api_keys, '{}'::jsonb) <> '{}'::jsonb
                ORDER BY created_at LIMIT 1"""
        )
    if row is None:
        return None, {}

    stored = _as_dict(row["api_keys"])
    keys = {k: d for k, v in stored.items()
            if isinstance(v, str) and (d := _decrypt(v)) is not None}
    # None, not the owner's id: outreach_log.sent_by and enrichment_log.requested_by
    # record who asked for THIS job, and attributing a scheduled run to a person
    # would be wrong even though we borrowed their credentials.
    return None, keys


def env_or_key(api_keys: dict[str, str], *names: str) -> str:
    """First non-empty value among `names` in api_keys, then os.environ.

    Keys saved in Settings win over process env so a per-user key takes effect
    immediately; env remains the fallback for single-tenant deployments.
    """
    for n in names:
        v = api_keys.get(n)
        if v:
            return v
    for n in names:
        v = os.environ.get(n)
        if v:
            return v
    return ""
