"""SSRF guard on every egress path (ported from Agent Reach's URL normaliser).

Scrapers fetch URLs lifted out of scraped HTML -- job links, career pages, sitemap
children, apply buttons -- so those strings are attacker-influenced. The previous
check was `url.startswith(("http://", "https://"))`, which passes the cloud instance
metadata endpoint and our own Redis/Postgres.
"""
import ast
import importlib
import inspect

import pytest

from scrapers.utils.http_client import assert_public_http_url


@pytest.mark.parametrize("url", [
    "http://169.254.169.254/latest/meta-data/iam/security-credentials/",  # AWS
    "http://[fd00::1]/",                     # ipv6 unique-local
    "http://[::1]/",                         # ipv6 loopback
    "http://127.0.0.1:5432/",                # our postgres
    "http://localhost:6379/",                # our redis
    "http://0.0.0.0/",
    "http://10.0.5.9/admin",                 # rfc1918
    "http://172.16.0.1/",
    "http://192.168.1.1/",
    "http://100.64.0.1/",                    # cgnat
    "http://redis:6379/",                    # bare docker service name
    "http://postgres:5432/",
    "http://metadata.google.internal/",
    "http://foo.local/",
    "http://user:pass@example.com/",         # credential smuggling
    "file:///etc/passwd",
    "gopher://x/y",
    "https://example.com/a\r\nX-Injected: 1",  # header injection via CRLF
    "https://exam\tple.com/",
    "http://example.com:99999/",             # invalid port
    "",
])
def test_untrusted_targets_rejected(url):
    with pytest.raises(ValueError):
        assert_public_http_url(url)


@pytest.mark.parametrize("url", [
    "https://www.indeed.co.uk/viewjob?jk=abc",
    "https://api.lever.co/v0/postings/acme?format=json",
    "http://example.com/path",
    "example.com/careers",                       # scheme-less gets https
    "https://sub.domain.co.uk/a?b=1&c=2#frag",
])
def test_legitimate_scrape_targets_allowed(url):
    assert assert_public_http_url(url)


def test_fetch_uses_the_guard():
    """A guard nothing calls is decoration -- assert fetch() routes through it."""
    src = inspect.getsource(_fetch_fn())
    assert "assert_public_http_url" in src
    assert 'startswith(("http://"' not in src, "the weak prefix check must be gone"


def _fetch_fn():
    from scrapers.utils.http_client import fetch
    return fetch


# These three fetch with aiohttp directly instead of http_client.fetch, so each
# needs its own guard call or it stays an open SSRF route.
#
# Asserted structurally rather than behaviourally on purpose. A return-value test
# cannot distinguish "guard rejected" from "socket failed" -- both yield None -- so
# it stayed green with the gate deleted; mock-patching aiohttp also failed because
# these modules import aiohttp inside the function body. Checking that the guard is
# called before session.get() is stable, reviewable, and does fail when removed.
GUARDED_FUNCS = {
    "scrapers.utils.career_page_extractor": "fetch_page",
    "scrapers.utils.company_hr_extractor": "_fetch_text",
    "scrapers.offcampus_aggregators": "_get",
}


@pytest.mark.parametrize("module_path,fn_name", list(GUARDED_FUNCS.items()))
def test_raw_egress_functions_validate_before_request(module_path, fn_name):
    tree = ast.parse(inspect.getsource(importlib.import_module(module_path)))
    fns = [n for n in ast.walk(tree)
           if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == fn_name]
    assert fns, f"{module_path}.{fn_name} not found"

    def _lineno(node):
        return getattr(node, "lineno", 10 ** 9)

    guard_lines, request_lines = [], []
    for node in ast.walk(fns[0]):
        if not isinstance(node, ast.Call):
            continue
        name = getattr(node.func, "id", None) or getattr(node.func, "attr", None)
        if name == "assert_public_http_url":
            guard_lines.append(_lineno(node))
        elif name == "get":
            request_lines.append(_lineno(node))
    assert guard_lines, f"{fn_name} never calls assert_public_http_url"
    assert request_lines, f"{fn_name} has no outgoing request to gate"
    assert min(guard_lines) < min(request_lines), \
        f"{fn_name} validates AFTER issuing the request"
