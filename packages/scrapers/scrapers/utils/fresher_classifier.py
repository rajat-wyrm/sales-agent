"""Shared utility for fresher role classification (SRS §4.2b)."""
import re

FRESHER_KEYWORDS = [
    "fresher", "0-1 years", "0-1yr", "0-2 years", "0-2yr",
    "no experience", "no-experience", "entry level", "entry-level",
    "graduate trainee", "campus hire", "0 years",
    "intern", "internship", "new grad", "new-grad",
    # India fresher-hiring idiom: "junior"/"graduate" (e.g. "BE graduate",
    # "Junior Developer") denote entry level within this product's fresher scope.
    "junior", "graduate", "undergraduate", "freshers",
]


def is_fresher_role(title: str, experience: str = "", full_text: str = "") -> bool:
    """NLP keyword classifier with word-boundary matching per SRS §4.2b.

    Uses regex word boundaries to avoid false positives (e.g., 'internally'
    matching 'intern').
    """
    combined = f"{title} {experience} {full_text}".lower()
    for kw in FRESHER_KEYWORDS:
        pattern = rf'\b{re.escape(kw)}\b'
        if re.search(pattern, combined):
            return True
    return False
