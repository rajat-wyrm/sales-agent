"""Mail-exchange existence check -- free, before spending a verification call.

Reacher's SMTP handshake costs a round trip per address (and Reacher itself is the
bottleneck on large runs). Most unusable addresses fail one of two cheap tests:
the domain does not exist at all, or it has no MX record so nothing can ever
receive mail there. Both are answerable with a DNS query.

Why this catches what getaddrinfo() cannot: "gmial.com" resolves fine -- squatters
register common typos and point them at a parking host -- but has no usable mail
path, or worse accepts and silently drops. Only an MX lookup separates "a mailbox
can live here" from "somebody owns the name".

dnspython is used when importable; otherwise we degrade to a hostname check rather
than failing verification outright, because a missing optional dependency must never
block the pipeline.
"""
from __future__ import annotations

import asyncio
import logging
import re
import time
from typing import Optional

logger = logging.getLogger("scraper.mx")

try:  # optional: absent deps degrade to a weaker check, never an error
    import dns.resolver  # type: ignore
    import dns.exception  # type: ignore
    _HAVE_DNSPYTHON = True
except ImportError:  # pragma: no cover
    _HAVE_DNSPYTHON = False

_EMAIL_RE = re.compile(r"^[^@\s]+@([A-Za-z0-9._-]+)$")

# Per-domain cache: MX records rarely change and a run revisits the same employers.
_CACHE: dict[str, tuple[bool, float]] = {}
_CACHE_TTL = 6 * 3600.0
_MAX_ENTRIES = 5000


def email_domain(email: str) -> Optional[str]:
    """Domain part of an address, or None if it is not a bare valid-looking one."""
    m = _EMAIL_RE.match((email or "").strip())
    return m.group(1).lower().rstrip(".") if m else None


def _cache_get(domain: str) -> Optional[bool]:
    hit = _CACHE.get(domain)
    if not hit:
        return None
    ok, expires = hit
    if expires < time.monotonic():
        _CACHE.pop(domain, None)
        return None
    return ok


def _cache_put(domain: str, ok: bool) -> None:
    if len(_CACHE) >= _MAX_ENTRIES:
        # Drop the oldest-expiring third rather than the whole map, so a long run
        # keeps its hot domains.
        for k in sorted(_CACHE, key=lambda d: _CACHE[d][1])[: _MAX_ENTRIES // 3]:
            _CACHE.pop(k, None)
    _CACHE[domain] = (ok, time.monotonic() + _CACHE_TTL)


def _resolve_mx_blocking(domain: str, timeout: float) -> Optional[bool]:
    """True = has a usable MX, False = none/NXDOMAIN, None = could not ask."""
    try:
        answers = dns.resolver.resolve(domain, "MX", lifetime=timeout)
    except dns.resolver.NXDOMAIN:
        return False
    except dns.resolver.NoAnswer:
        # No MX record: RFC 5321 lets mail fall back to an A record, so treat a
        # host that resolves as deliverable rather than rejecting real mailboxes.
        try:
            dns.resolver.resolve(domain, "A", lifetime=timeout)
            return True
        except Exception:
            return False
    except (dns.exception.DNSException, OSError, TimeoutError):
        return None  # resolver problem -- unknown, do NOT mark the address bad
    for rdata in answers:
        try:
            host = str(rdata.exchange).rstrip(".").lower()
        except Exception:  # noqa: BLE001
            continue
        if host:
            return True
    return False


async def domain_accepts_mail(domain: str, timeout: float = 2.5) -> Optional[bool]:
    """Whether `domain` can receive mail. None means "unknown", not "invalid"."""
    if not domain:
        return None
    cached = _cache_get(domain)
    if cached is not None:
        return cached
    if not _HAVE_DNSPYTHON:
        return None
    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(None, _resolve_mx_blocking, domain, timeout)
    if result is not None:
        _cache_put(domain, result)
    return result


async def check_email_deliverability(email: str) -> dict:
    """Cheap pre-flight for one address.

    Returns {"mx": True/False/None, "reason": str}. Callers must only treat
    mx=False as a rejection; None is inconclusive and should proceed normally, so a
    flaky resolver never marks good mailboxes dead.
    """
    domain = email_domain(email)
    if not domain:
        return {"mx": False, "reason": "malformed_address"}
    ok = await domain_accepts_mail(domain)
    if ok is None:
        return {"mx": None, "reason": "dns_unavailable" if not _HAVE_DNSPYTHON else "dns_error"}
    return {"mx": ok, "reason": "mx_ok" if ok else "no_mx_records"}


async def filter_verifiable(emails: list[str]) -> tuple[list[str], list[tuple[str, str]]]:
    """Split into (worth verifying, skipped-with-reason) without losing any input."""
    keep: list[str] = []
    skipped: list[tuple[str, str]] = []
    for e in emails:
        r = await check_email_deliverability(e)
        if r["mx"] is False:
            skipped.append((e, r["reason"]))
        else:
            keep.append(e)  # True or unknown both proceed
    return keep, skipped
