"""
Central India geo-gate (HireGen product correction: fresher jobs / leads from
INDIA ONLY, not worldwide).

This is a post-scrape filter analogous to the experience-level re-validation in
SRS §4.2(b): it is the one place a record may legitimately be *discarded*
because it is out-of-scope (not a fresher role, or not an India role). This is
distinct from SRS §9.7 "never silently drop scraped data" — which governs
*incomplete-but-in-scope* records. An out-of-scope (non-India) record is not a
data-quality problem, it is a wrong-target problem, exactly like a senior role.

Multiple fallbacks, in order:
  1. If the source is India-native by construction (naukri, shine, internshala,
     ...), it passes unless its explicit location field is *strongly foreign*.
  2. Otherwise a positive India signal in location → pass.
  3. If location is blank, fall back to scanning the job description /
     about_job text for an India signal.
  4. If still ambiguous: for global sources we REJECT (cannot confirm India),
     for India-native sources we PASS (already scoped to India).

The function never mutates the record; the caller decides to discard.
"""

import re

# Sources that publish ONLY India-region postings by their nature.
# For these, a blank/absent location field still counts as India.
INDIA_NATIVE_SOURCES = {
    "naukri", "shine", "internshala", "freshersworld", "instahyre",
    "cutshort", "foundit", "adzuna", "jooble", "indeed", "workday",
}

# Strong positive India location signals.
_INDIA_POSITIVE = [
    "india", "भारत",
    "bengaluru", "bangalore", "mumbai", "delhi", "new delhi", "ncr",
    "gurgaon", "gurugram", "noida", "hyderabad", "chennai", "pune",
    "kolkata", "ahmedabad", "surat", "jaipur", "kochi", "cochin",
    "chandigarh", "bhubaneswar", "indore", "nagpur", "vadodara",
    "visakhapatnam", "mysore", "mysuru", "thiruvananthapuram",
    "trivandrum", "coimbatore", "lucknow", "kanpur", "patna",
    "bhopal", "rajkot", "goa", "manali", "dehradun",
    "remote - india", "remote/india", "remote (india)", "work from india",
    "wfo india", "wfh india", "+91", "west bengal", "tamil nadu",
    "karnataka", "maharashtra", "telangana", "andhra", "gujarat",
    "rajasthan", "uttar pradesh", "madhya pradesh", "kerala",
    "harayana", "haryana", "punjab india", "bihar", "odisha",
]

# Strong foreign (non-India) location signals.
_FOREIGN = [
    "united states", "usa", "u.s.a", " u.s.", "us only", "us-based",
    "us based", "california", "new york", "texas", "washington dc",
    "seattle", "san francisco", "austin", "boston", "chicago",
    "united kingdom", "uk only", "u.k.", " london", "england",
    "germany", "berlin", "munich", "france", "paris", "netherlands",
    "amsterdam", "spain", "madrid", "barcelona", "italy", "rome",
    "poland", "warsaw", "portugal", "lisbon", "ireland", "dublin",
    "canada", "toronto", "vancouver", "montreal", "australia",
    "sydney", "melbourne", "brazil", "sao paulo", "mexico",
    "singapore", "japan", "tokyo", "china", "beijing", "shanghai",
    "south korea", "seoul", "dubai", "uae", "saudi", "qatar",
    "israel", "tel aviv", "turkey", "istanbul", "nigeria", "lagos",
    "kenya", "nairobi", "south africa", "johannesburg", "cape town",
    "europe", "emea", "apac", "north america", "latam", "worldwide",
    "global", "anywhere", "remote - us", "remote - europe",
    "remote - uk", "remote - canada",
]

# Compile word-boundary regexes once. Pre-pad single-token entries with a
# boundary; multi-word entries use plain substring after normalization.
_INDIA_RE = re.compile(
    r"\b(" + "|".join(re.escape(t.strip()) for t in _INDIA_POSITIVE if t.strip()) + r")\b"
)
_FOREIGN_RE = re.compile(
    r"\b(" + "|".join(re.escape(t.strip()) for t in _FOREIGN if t.strip()) + r")\b"
)


def _norm(text: str) -> str:
    return f" {(text or '').lower()} "


def is_india_relevant(normalized: dict) -> bool:
    """Return True if the lead should be kept (India-relevant)."""
    source_site = (normalized.get("source_site") or "").lower()
    location = _norm(normalized.get("location", ""))
    about_job = _norm(normalized.get("about_job", ""))

    # Layered signals. location is authoritative when present; description is
    # the fallback used only to break ties / confirm ambiguous cases.
    loc_has_india = bool(_INDIA_RE.search(location))
    loc_has_foreign = bool(_FOREIGN_RE.search(location))
    desc_has_india = bool(_INDIA_RE.search(about_job))

    # 1. Explicit foreign location on the posting → reject, even if the
    #    description happens to mention India. Location wins over description.
    if loc_has_foreign and not loc_has_india:
        return False

    # 2. Explicit India location signal → accept.
    if loc_has_india:
        return True

    # 3. Location blank/ambiguous → check description, then source nativeness.
    if desc_has_india:
        return True

    # 4. India-native source with no contradicting foreign signal → accept.
    if any(s in source_site for s in INDIA_NATIVE_SOURCES):
        return True

    # 5. Global source, no positive India evidence → reject (fail closed).
    return False
