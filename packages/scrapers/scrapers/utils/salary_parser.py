"""Parse free-text salary into structured numbers.

Job boards publish salary as loose text ("₹350,000 - ₹400,000 annually",
"1-3 LPA", "₹2,000 - ₹19,500 monthly"). The UI wants to filter and sort by pay,
which needs numbers -- but a salary is also the single easiest field to get
wrongly fabricated, and a wrong number on a lead is worse than no number: it
drives scoring, ranking and the outreach copy. So this module is deliberately
conservative:

  * It never invents a currency, period or amount. Anything ambiguous returns
    None for the derived fields while the caller keeps the verbatim string.
  * `salary_range` (the source's own words) stays authoritative and untouched;
    these columns are explicitly the parsed/derived view.
  * A bare "₹12 - ₹15" with no period and no LPA/CPA marker is NOT guessed --
    that could be per day, per month or annual lakhs.

Supported shapes (observed in production data):
  ₹350,000 - ₹400,000 annually   -> 350000..400000 / year
  ₹2,000 - ₹19,500 monthly       -> 2000..19500 / month
  1-3 LPA                        -> 100000..300000 / year  (lakh per annum)
  ₹800 - ₹1,000 per day          -> 800..1000 / day
  $40,000-$60,000 / year         -> 40000..60000 USD / year
  "Not disclosed" / "" / None    -> all fields None
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional

# Multiplier applied to a raw number to reach the stated currency's units.
_LAKH = 100_000
_CRORE = 10_000_000
_K = 1_000

_PERIOD_WORDS = {
    "year": "year", "yearly": "year", "annum": "year", "annual": "year",
    "annually": "year", "pa": "year", "p.a": "year", "p.a.": "year",
    "per annum": "year", "lpa": "year", "ctc/year": "year", "/year": "year",
    "/yr": "year", "yr": "year",
    "month": "month", "monthly": "month", "pm": "month", "per month": "month",
    "ma": "month", "/month": "month", "/mo": "month", "mo": "month",
    "week": "week", "weekly": "week", "/week": "week", "pw": "week",
    "day": "day", "daily": "day", "/day": "day", "per day": "day", "pd": "day",
    "hour": "hour", "hourly": "hour", "/hr": "hour", "hr": "hour",
    "per hour": "hour", "ph": "hour",
}

_CURRENCY_SYMBOLS = {"₹": "INR", "Rs": "INR", "Rs.": "INR", "INR": "INR",
                     "$": "USD", "USD": "USD", "€": "EUR", "EUR": "EUR",
                     "£": "GBP", "GBP": "GBP"}

# "1-3 LPA", "₹350,000 - ₹400,000", "₹12,000/month". The leading currency
# symbol / "Rs." is allowed on either side of the separator, because boards write
# "₹350,000 - ₹400,000" as often as "₹350,000 - 400,000"; without this the second
# group would capture the wrong digits and collapse min/max to the same value.
_PREFIX = r"(?:₹|Rs\.?|\$|€|£)?\s*"
_NUM = r"\d[\d,]*(?:\.\d+)?"
_RANGE_RE = re.compile(
    rf"(?P<lo>{_NUM})\s*(?:-|–|to|~)\s*{_PREFIX}(?P<hi>{_NUM})", re.I,
)
_SINGLE_RE = re.compile(rf"(?P<val>{_NUM})")
# k / lakh / lac / crore suffixes attached to a number: "1.5L", "40k", "2cr"
_SUFFIX_RE = re.compile(r"(?P<num>{})\s*(?P<suf>k|km|l|lakh|lakhs|lac|lacs|cr|crore)\b".format(_NUM), re.I)


@dataclass
class ParsedSalary:
    salary_min: Optional[float] = None
    salary_max: Optional[float] = None
    salary_currency: Optional[str] = None
    salary_period: Optional[str] = None

    @property
    def usable(self) -> bool:
        return self.salary_min is not None or self.salary_max is not None


def _detect_currency(text: str) -> Optional[str]:
    for sym, code in _CURRENCY_SYMBOLS.items():
        if sym in text:
            return code
    return None


def _detect_period(text: str) -> Optional[str]:
    low = text.lower()
    # Longest keys first so "per annum" beats "annum", "/month" beats "month".
    for word in sorted(_PERIOD_WORDS, key=len, reverse=True):
        if word in low:
            return _PERIOD_WORDS[word]
    return None


def _strip_separators(num: str) -> float:
    return float(num.replace(",", ""))


def _apply_suffix(value: float, suffix: Optional[str], has_lpa: bool) -> float:
    s = (suffix or "").lower()
    if s in ("k", "km"):
        return value * _K
    if s in ("l", "lakh", "lakhs", "lac", "lacs"):
        return value * _LAKH
    if s in ("cr", "crore"):
        return value * _CRORE
    if has_lpa:  # "1-3 LPA" -> the number is already in lakhs
        return value * _LAKH
    return value


def _suffix_for(text: str, start: int, end: int) -> Optional[str]:
    m = _SUFFIX_RE.search(text, max(0, start - 2), min(len(text), end + 6))
    if m and m.group("num").replace(",", "") == text[start:end].replace(",", ""):
        return m.group("suf")
    return None


def _trim_trailing_prefix(raw: str, lo_s: str, hi_s: str) -> tuple[str, str]:
    """Return the numeric groups with any captured currency prefix removed."""
    clean = lambda v: re.sub(rf"^{_PREFIX}", "", v).strip()
    return clean(lo_s), clean(hi_s)


def parse_salary(text: Optional[str]) -> ParsedSalary:
    """Derive numeric salary from a free-text range. Conservative on ambiguity."""
    if not text or not str(text).strip():
        return ParsedSalary()
    raw = str(text).strip()
    low = raw.lower()

    if any(w in low for w in ("not disclosed", "not specified", "n/a", "na ", "unspecified",
                              "as per industry", "industry standard", "best in industry")):
        return ParsedSalary()

    currency = _detect_currency(raw)
    # LPA/CPA imply INR even when the ₹ symbol is absent ("1-3 LPA").
    lpa = bool(re.search(r"\b(?:lpa|cpa|lp)\b", low))
    if lpa and currency is None:
        currency = "INR"
    period = _detect_period(raw)
    if lpa and period is None:
        period = "year"

    rng = _RANGE_RE.search(raw)
    if rng:
        lo_s, hi_s = rng.group("lo"), rng.group("hi")
        suf = _suffix_for(raw, rng.start("lo"), rng.end("hi"))
        lo = _apply_suffix(_strip_separators(lo_s), suf, lpa)
        hi = _apply_suffix(_strip_separators(hi_s), suf, lpa)
    else:
        m = _SINGLE_RE.search(raw)
        if not m:
            return ParsedSalary()
        val_s = m.group("val")
        suf = _suffix_for(raw, m.start("val"), m.end("val"))
        lo = hi = _apply_suffix(_strip_separators(val_s), suf, lpa)

    # Without a period the number is meaningless for comparison: "₹12 - ₹15"
    # could be per day or annual lakhs. Refuse to guess.
    if period is None:
        return ParsedSalary(salary_currency=currency)

    if lo > hi:
        lo, hi = hi, lo

    # Sanity ceiling: an un-suffixed "350,000" read as monthly is implausible for
    # fresher roles; treat > 1e8 as a parse mistake and drop the numbers.
    if max(lo, hi) > 1e8:
        return ParsedSalary(salary_currency=currency, salary_period=period)

    return ParsedSalary(salary_min=lo, salary_max=hi, salary_currency=currency, salary_period=period)


def as_columns(p: ParsedSalary) -> dict:
    """Dict for asyncpg/SQL parameter binding (None => SQL NULL)."""
    return {
        "salary_min": p.salary_min,
        "salary_max": p.salary_max,
        "salary_currency": p.salary_currency,
        "salary_period": p.salary_period,
    }
