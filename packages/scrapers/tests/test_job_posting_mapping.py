"""Salary/location mapping from scraped text -> job_postings columns.

These cases are all real shapes produced by the sources wired into SCRAPER_MAP;
the Indian-scale conversions and the "do not invent a salary" guards are the
parts most likely to regress silently.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest

from scrapers.normalizer import job_posting_columns, normalize_lead  # noqa: E402


def _cols(raw: dict) -> dict:
    return job_posting_columns(normalize_lead({
        "company_name": "Acme", "job_title": "Engineer", "url": "https://x/1",
        "location": "Pune", **raw,
    }))


def test_lakh_range_with_trailing_unit():
    # "₹25-45 LPA" puts the unit on the last number only; both ends must scale.
    c = _cols({"about_job": "Salary: Not Disclosed (₹25-45 LPA)"})
    assert (c["salary_min"], c["salary_max"]) == (2_500_000.0, 4_500_000.0)
    assert c["salary_currency"] == "INR"
    assert c["salary_period"] == "year"


def test_lakh_on_both_ends():
    c = _cols({"about_job": "Package 8 LPA to 12 LPA"})
    assert (c["salary_min"], c["salary_max"]) == (800_000.0, 1_200_000.0)


def test_decimal_lakh_and_crore():
    assert (_cols({"about_job": "CTC: 3.5 - 6 lakh per annum"})["salary_min"]) == 350_000.0
    assert (_cols({"about_job": "1 - 2 crore package"})["salary_max"]) == 20_000_000.0


def test_thousands_suffix():
    c = _cols({"about_job": "Salary 50k - 80k"})
    assert (c["salary_min"], c["salary_max"]) == (50_000.0, 80_000.0)


def test_ctc_fields_are_already_lakhs():
    # AmbitionBox sends minCtc/maxCtc as plain lakh figures.
    c = _cols({"about_job": "role", "raw_payload": {"minCtc": 8, "maxCtc": 14}})
    assert (c["salary_min"], c["salary_max"]) == (800_000.0, 1_400_000.0)


def test_structured_salary_range_usd():
    c = _cols({"about_job": "x", "salary_range": "$80,000 - $120,000 per year"})
    assert (c["salary_min"], c["salary_max"], c["salary_currency"]) == (80_000.0, 120_000.0, "USD")


def test_no_salary_invented_from_non_money_numbers():
    """The dangerous failure: reading "0-2 years" or a batch year as pay."""
    for text in (
        "Open to 0-2 years, B.Tech 2026 batch",
        "Experience 1-3 years required",
        "For 2023-2026 batch passouts",
        "Great fresher role in Bengaluru",
    ):
        c = _cols({"about_job": text})
        assert c["salary_min"] is None and c["salary_max"] is None, text


def test_location_from_array_of_objects():
    c = _cols({"location": "", "about_job": "x",
               "raw_payload": {"locations": [{"location": "Chennai"}, {"location": "Bangalore"}]}})
    assert c["location"] == "Chennai, Bangalore"


def test_workplace_type_variants():
    assert _cols({"about_job": "x", "raw_payload": {"workMode": "Hybrid"}})["location_type"] == "hybrid"
    assert _cols({"about_job": "x", "raw_payload": {"workplaceType": "wfh"}})["location_type"] == "remote"
    # typeOfEmployment is deliberately NOT a workplace source any more; see
    # test_employment_type_is_not_the_workplace.


def test_hybrid_inferred_from_description():
    c = _cols({"about_job": "Internship in Gurugram on a hybrid work setup"})
    assert c["location_type"] == "hybrid"


def test_apply_url_falls_back_to_job_url():
    c = _cols({"about_job": "x", "raw_payload": {"applyUrl": "https://apply/here"}})
    assert c["apply_url"] == "https://apply/here"


def test_posted_at_accepts_iso_and_epoch_ms():
    assert _cols({"about_job": "x", "raw_payload": {"posted_at": "2026-09-02"}})["posted_at"] is not None
    assert _cols({"about_job": "x", "raw_payload": {"published_at": 1757900000000}})["posted_at"] is not None
    assert _cols({"about_job": "x", "raw_payload": {"posted_at": "not a date"}})["posted_at"] is None


# --- location flattening -----------------------------------------------------
# Boards send location as a string, an object, a {code,name} pair, a list of
# those, or JSON double-encoded inside a string. Anything non-string that reached
# job_postings.location printed braces in the CRM.

def test_location_object_prefers_fulllocation():
    from scrapers.normalizer import _flatten_location as F
    assert F({"city": "Bengaluru", "region": "KA", "country": "in",
              "fullLocation": "Bengaluru, KA, India"}) == "Bengaluru, KA, India"


def test_location_object_variants():
    from scrapers.normalizer import _flatten_location as F
    assert F({"code": "IN", "name": "India"}) == "India"
    assert F({"country": {"code": "us", "name": "United States"}}) == "United States"
    assert F({"city": "Pune"}) == "Pune"
    assert F([{"location": "Chennai"}, {"location": "Pune"}]) == "Chennai, Pune"
    assert F("Mumbai") == "Mumbai"
    assert F('{"city":"Hyderabad","country":"in"}') == "Hyderabad, in"
    assert F("") == "" and F(None) == "" and F({}) == ""


def test_location_column_never_contains_json_braces():
    # Empty top-level location so the mapper falls through to raw_payload.
    n = normalize_lead({"company_name": "C", "job_title": "T", "url": "https://x",
                        "about_job": "x", "location": "",
                        "raw_payload": {"location": {"city": "Bengaluru", "region": "KA",
                                                     "fullLocation": "Bengaluru, KA, India"}}})
    c = job_posting_columns(n)
    assert "{" not in (c["location"] or "") and "}" not in (c["location"] or "")
    assert c["location"] == "Bengaluru, KA, India"


def test_normalize_lead_flattens_dict_location():
    n = normalize_lead({"company_name": "C", "job_title": "T", "url": "https://x",
                        "about_job": "d", "location": {"city": "Noida", "region": "UP"}})
    assert isinstance(n["location"], str) and "{" not in n["location"]


# --- salary false-positive guards -------------------------------------------
# Real corpus text from internship sources. A loose numeric scan turned these
# into salaries (e.g. "1-2 Months" -> a ₹1–₹2 band), which is worse than NULL:
# it silently corrupts ranking and any salary-sorted view.

NON_MONEY_TEXTS = [
    "This internship runs for a duration of 1-2 Months.",
    "This one’s open to recent graduates from the 2026 and 2027 batches.",
    "Open to 0-2 years, B.Tech 2026 batch",
    "For 2023-2026 batch passouts",
    "Duration: 6 Months, location Bengaluru, hybrid",
    "Great fresher role in Bengaluru",
]


@pytest.mark.parametrize("text", NON_MONEY_TEXTS)
def test_non_money_text_never_becomes_a_salary(text):
    c = _cols({"about_job": text})
    assert c["salary_min"] is None, f"invented salary {c['salary_min']} from: {text}"
    assert c["salary_max"] is None


def test_trailing_unit_phrase_parses():
    # Anchor may sit after the numbers ("1 - 2 crore package").
    c = _cols({"about_job": "Annual CTC 1 - 2 crore package"})
    assert (c["salary_min"], c["salary_max"]) == (10_000_000.0, 20_000_000.0)


def test_sub_thousand_band_rejected():
    # Anything below ~₹1,000 cannot be pay; guard against anchored-but-duration
    # phrasings such as "stipend within 1-2 months".
    c = _cols({"about_job": "stipend within 1-2 months"})
    assert c["salary_min"] is None


# --- facet extraction: real payload shapes from the wired sources ------------

def test_object_labels_are_preferred_over_ids():
    # SmartRecruiters sends {"id": "engineering", "label": "Engineering"}.
    c = _cols({"about_job": "x", "raw_payload": {
        "typeOfEmployment": {"id": "permanent", "label": "Full-time"},
        "function": {"id": "engineering", "label": "Engineering"},
        "workplaceType": "Hybrid"}})
    # The DB CHECK demands the canonical enum, so the extracted label
    # ("Full-time") is mapped, not stored verbatim (verbatim == constraint
    # violation at insert time).
    assert c["employment_type"] == "full_time"
    assert c["department"] == "Engineering"
    assert c["location_type"] == "hybrid"


def test_employment_type_is_not_the_workplace():
    """typeOfEmployment is a job type, not remote/onsite; conflating them lost both."""
    c = _cols({"about_job": "x", "raw_payload": {
        "typeOfEmployment": {"id": "permanent", "label": "Internship"}}})
    assert c["employment_type"] == "internship"
    assert c["location_type"] is None


def test_html_opening_text_is_not_an_openings_count():
    # Freshersworld-style payloads carry "opening"/"openingPlain" = full HTML JD.
    c = _cols({"about_job": "x", "raw_payload": {
        "opening": "<div><b>Nium is hiring</b></div>",
        "openingPlain": "Nium, the leader in real-time global payments"}})
    assert c["openings_count"] is None


def test_numeric_openings_still_parsed():
    assert _cols({"about_job": "x", "raw_payload": {"openings": "3"}})["openings_count"] == 3
    assert _cols({"about_job": "x", "raw_payload": {"vacancies": 5}})["openings_count"] == 5


@pytest.mark.parametrize("text,want", [
    ("Fully remote role, work from home", "remote"),   # synonyms must not look ambiguous
    ("WFH internship, location independent", "remote"),
    ("Hybrid setup in Gurugram", "hybrid"),
    ("Must be onsite in the Bengaluru office", "onsite"),
    ("Based in Pune", None),                            # a city is not a work mode
    ("Great fresher opportunity", None),
])
def test_workplace_inferred_from_description(text, want):
    assert _cols({"about_job": text})["location_type"] == want


def test_empty_department_object_yields_none():
    assert _cols({"about_job": "x", "raw_payload": {"department": {}}})["department"] is None


# --- posted_at: five real source formats, no invented dates ------------------

def test_posted_at_parses_every_shape_seen_in_the_wild():
    from datetime import timedelta
    from scrapers.normalizer import parse_posted_at as p
    assert p("August 11, 2026").date().isoformat() == "2026-08-11"
    assert p("11 August 2026").date().isoformat() == "2026-08-11"
    assert p("2026-09-10").date().isoformat() == "2026-09-10"
    assert p("2026-09-12T06:48:33.071192+00:00").month == 9
    assert p("2026-09-04T07:12:34-04:00").utcoffset() == timedelta(hours=-4)
    assert p(1783081690).year > 2020            # epoch seconds
    assert p("1787468433504").year > 2020       # epoch milliseconds as a string
    assert p("1 day ago") is not None
    assert all(p(v).tzinfo is not None for v in
               ("August 11, 2026", "2026-09-10", 1783081690, "1 day ago"))


@pytest.mark.parametrize("bad", ["garbage text", "", "   ", None, {}, [], "13/13/2026"])
def test_unparseable_posted_at_stays_null(bad):
    """An empty column is honest; a guessed date would be fabricated data."""
    from scrapers.normalizer import parse_posted_at
    assert parse_posted_at(bad) is None


def test_posted_at_found_under_source_specific_key():
    # jobinsider-style payloads use posted_date, others use releasedDate/published.
    for key in ("posted_date", "releasedDate", "published", "first_published", "createdAt"):
        c = _cols({"about_job": "x", "raw_payload": {key: "September 10, 2026"}})
        assert c["posted_at"] is not None, key
