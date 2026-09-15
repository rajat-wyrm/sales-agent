"""The draft prompt must actually be formattable.

draft_worker calls DRAFT_PROMPT_TEMPLATE.format(...). The template also contains a
JSON *example*, whose braces str.format treats as field names, so format() raised
KeyError every single time -- inside a try/except, which silently dropped every
Gemini draft to the template fallback. Nothing caught it because no test had ever
called format(). These assertions are the whole point of this file.
"""
import string
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scrapers.draft_worker import DRAFT_PROMPT_TEMPLATE  # noqa: E402

PLACEHOLDERS = {
    "company_name", "job_title", "experience_level", "about_company", "about_job",
    "hr_name", "salary_range", "job_url", "location", "workplace_type",
    "department", "openings_count", "prior_correspondence",
}


def _fields(tpl: str) -> set[str]:
    return {f for _, f, _, _ in string.Formatter().parse(tpl) if f}


def test_template_formats_with_all_keys():
    out = DRAFT_PROMPT_TEMPLATE.format(**{k: f"<{k}>" for k in PLACEHOLDERS})
    assert "<company_name>" in out and "{company_name}" not in out


def test_no_unexpected_fields_in_template():
    """A new {foo} placeholder without a matching key is the exact bug here."""
    assert _fields(DRAFT_PROMPT_TEMPLATE) == PLACEHOLDERS


def test_json_example_survives_escaping():
    out = DRAFT_PROMPT_TEMPLATE.format(**{k: "x" for k in PLACEHOLDERS})
    # The model is told to answer with JSON; that example must render literally.
    assert '"email_draft"' in out and '"whatsapp_draft"' in out
    assert '{\n  "email_draft": {' in out or '{"email_draft"' in out.replace("\n", "").replace("  ", "")


def test_format_needs_no_extra_arguments():
    # Missing-key robustness: every placeholder must be one we always supply.
    missing = PLACEHOLDERS - _fields(DRAFT_PROMPT_TEMPLATE)
    assert not missing, f"template ignores supplied fields: {missing}"
