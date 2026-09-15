"""WHOIS stage degradation.

Port 43 is blocked on most container networks and many cloud egress policies, so
the lookup fails for every company. Before the circuit breaker that cost four
sequential 10s timeouts per lead -- the normalizer appeared to hang and throughput
collapsed to a trickle while producing zero results. The breaker must trip fast and
then make no further attempts.
"""
import inspect
import importlib
import sys
import time
import types
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scrapers import normalizer as N


@pytest.fixture
def blocked_whois(monkeypatch):
    """Pretend port 43 is filtered: every query raises immediately."""
    calls = {"n": 0}

    def fake(q):
        calls["n"] += 1
        raise OSError("timed out")

    real_import = __import__

    def spy(name, *a, **k):
        if name == "whois":
            mod = types.ModuleType("whois")
            mod.whois = fake
            return mod
        return real_import(name, *a, **k)

    monkeypatch.setattr(__builtins__ if isinstance(__builtins__, types.ModuleType)
                        else sys.modules["builtins"], "__import__", spy)
    monkeypatch.setattr(N, "_whois_cache", {})
    monkeypatch.setattr(N, "_whois_consecutive_failures", 0)
    monkeypatch.setattr(N, "_whois_disabled", False)
    return calls


def test_breaker_trips_after_three_failures(blocked_whois):
    import asyncio

    async def run():
        for i in range(8):
            await N.run_whois_lookup(f"company{i}")
    asyncio.run(run())

    assert N._whois_disabled is True
    # 3 companies x 4 TLDs, then nothing more -- not 8 x 4.
    assert blocked_whois["n"] <= 12, f"kept querying after disable: {blocked_whois['n']}"


def test_no_queries_once_disabled(blocked_whois):
    import asyncio

    async def run():
        for i in range(5):
            await N.run_whois_lookup(f"c{i}")
        after_trip = blocked_whois["n"]
        for i in range(5, 40):
            await N.run_whois_lookup(f"c{i}")
        return after_trip, blocked_whois["n"]
    before, after = asyncio.run(run())
    assert before == after, "made WHOIS queries after the breaker opened"


def test_disabled_company_returns_explanatory_error(blocked_whois):
    import asyncio

    async def run():
        for i in range(4):
            await N.run_whois_lookup(f"x{i}")
        return await N.run_whois_lookup("late-company")
    email, meta = asyncio.run(run())
    assert email is None
    assert meta["error"] == "whois_disabled_after_repeated_failures"


def test_missing_module_disables_immediately(monkeypatch):
    """ImportError must not be retried per company -- it can never succeed."""
    real_import = __import__

    def spy(name, *a, **k):
        if name == "whois":
            raise ImportError("python-whois not installed")
        return real_import(name, *a, **k)

    monkeypatch.setattr(sys.modules["builtins"], "__import__", spy)
    monkeypatch.setattr(N, "_whois_cache", {})
    monkeypatch.setattr(N, "_whois_consecutive_failures", 0)
    monkeypatch.setattr(N, "_whois_disabled", False)

    import asyncio
    start = time.time()
    email, meta = asyncio.run(N.run_whois_lookup("acme"))
    assert email is None and meta["error"] == "python-whois not installed"
    assert N._whois_disabled is True
    assert time.time() - start < 1.0


def test_success_resets_the_counter(monkeypatch):
    """A working network must not stay penalised by earlier failures."""
    good = types.SimpleNamespace(
        registrar="Acme Registrar",
        emails=["hr@acme.com"],
        get=lambda self, k, d=None: getattr(self, k, d),
    )

    class W(dict):
        def __getattr__(self, k):
            return self.get(k)

    parsed = W(registrar="Acme Registrar", emails=["hr@acme.com"])

    def fake(q):
        return parsed

    real_import = __import__

    def spy(name, *a, **k):
        if name == "whois":
            mod = types.ModuleType("whois")
            mod.whois = fake
            return mod
        return real_import(name, *a, **k)

    monkeypatch.setattr(sys.modules["builtins"], "__import__", spy)
    monkeypatch.setattr(N, "_whois_cache", {})
    monkeypatch.setattr(N, "_whois_consecutive_failures", 2)
    monkeypatch.setattr(N, "_whois_disabled", False)

    import asyncio
    email, meta = asyncio.run(N.run_whois_lookup("acme"))
    assert email == "hr@acme.com"
    assert N._whois_consecutive_failures == 0
    assert N._whois_disabled is False


# --- holehe output parsing ---------------------------------------------------

def test_holehe_parses_real_result_lines_and_ignores_the_legend():
    """holehe 1.61 has no --json flag; the old call passed it, the CLI exited
    non-zero on 'unrecognized arguments', and every check silently came back
    valid=False. Parsing '[+]/[-]/[x]' lines is the only working contract, and the
    legend line starts with '[+]' too, so a loose match marks dead domains valid."""
    import re
    from scrapers.normalizer import run_holehe_check
    src = inspect.getsource(run_holehe_check)
    # Assert on the invoked arguments, not the whole source: the docstring explains
    # that --json does not exist and would otherwise trip a naive substring check.
    argv = src[src.index("asyncio.create_subprocess_exec"):].split("\n")[1]
    assert "--json" not in argv, "holehe has no --json; passing it fails the call"
    # The pattern as written in the module, exercised against real-shaped output.
    pat = re.search(r're\.findall\(r"([^"]+)"', src).group(1)
    sample = (
        "[+] gmail.com\n[-] zoho.com\n[x] xing.com\n[+] twitter.com\n"
        "[?] npm\n[+] Email used, [-] Email not used, [x] Rate limit\n"
    )
    found = re.findall(pat, sample, re.I | re.M)
    assert found == ["gmail.com", "twitter.com"], found


def test_rate_limited_platforms_are_not_treated_as_valid():
    """'[x]' means rate limited -- an unknown, not evidence the mailbox exists."""
    import re
    from scrapers.normalizer import run_holehe_check
    pat = re.search(r're\.findall\(r"([^"]+)"', inspect.getsource(run_holehe_check)).group(1)
    assert re.findall(pat, "[x] github.com\n[x] adobe.com\n", re.I | re.M) == []
