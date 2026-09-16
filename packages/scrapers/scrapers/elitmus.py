"""
Tier 1: eLitmus scraper — India fresher jobs.

eLitmus is a fresher-first assessment + hiring platform; its /jobs board is
server-rendered HTML (no browser needed) with one card per posting carrying the
job link (/jobs/<id>-<slug>), company, employment type, location, fresher batch
and salary. Cards stamped with the expired ribbon are skipped — re-scraping
dead postings only creates leads nobody can apply to.

Extracts per SRS §4.4 schema.
"""

import re
import logging
from typing import Any

from .base import BaseScraper, now_iso

logger = logging.getLogger(__name__)


class ElitmusScraper(BaseScraper):
    source_name = "elitmus"
    tier = 1
    rate_limit_seconds = 2.0

    BASE = "https://www.elitmus.com"
    LIST_URL = "https://www.elitmus.com/jobs?experience_category=fresher"

    _CARD = re.compile(
        r'<div class="mb-1 bg-white card-shadow border-bottom custom-card-height overflow-hidden">(.*?)<script',
        re.S,
    )
    _LINK = re.compile(r'<a[^>]*href="(/jobs/\d+-[^"]+)"[^>]*>([^<]{2,140})</a>')
    _COMPANY = re.compile(r'<div class="false">([^<]{1,120})</div>')
    _META = re.compile(r'<span class="text-secondary">(.*?)</span>', re.S)
    _SALARY = re.compile(r'₹\s*([\d,]+)')
    _TAG = re.compile(r'<[^>]+>')

    @classmethod
    def parse_cards(cls, html: str) -> list[dict[str, str]]:
        """Pure parser (unit-tested): one dict per live card."""
        out: list[dict[str, str]] = []
        for block in cls._CARD.findall(html):
            if "expired-fork-ribbon" in block:
                continue
            m = cls._LINK.search(block)
            if not m:
                continue
            path, title = m.group(1), m.group(2).strip()
            company = ""
            cm = cls._COMPANY.search(block)
            if cm:
                company = cm.group(1).strip()
            employment, location, experience, salary = "", "", "", ""
            mm = cls._META.search(block)
            if mm:
                lines = [
                    cls._TAG.sub("", part).strip()
                    for part in re.split(r'<br\s*/?>', mm.group(1))
                ]
                lines = [ln for ln in lines if ln]
                for ln in lines:
                    low = ln.lower()
                    if "fresher" in low or "experience" in low or re.search(r'\(\d{4}\s*to\s*\d{4}\)', ln):
                        experience = ln
                    elif "india" in low:
                        location = ln
                    elif not employment and "," not in ln and len(ln) < 30:
                        employment = ln
                sm = cls._SALARY.search(mm.group(1))
                if sm:
                    salary = sm.group(1)
            if not title:
                continue
            out.append({
                "title": title,
                "url": cls.BASE + path,
                "company": company,
                "employment": employment,
                "location": location,
                "experience": experience or "Fresher",
                "salary": salary,
            })
        return out

    async def scrape(self) -> list[dict[str, Any]]:
        from .utils.http_client import fetch
        from .utils.fresher_classifier import is_fresher_role

        leads: list[dict[str, Any]] = []
        try:
            resp = await fetch(self.LIST_URL, timeout=30, min_engine="curl", max_engine="playwright")
            html = resp.text
        except Exception as e:  # noqa: BLE001
            self._logger.warning(f"eLitmus fetch failed: {e}")
            return leads

        seen: set[str] = set()
        for card in self.parse_cards(html):
            if card["url"] in seen:
                continue
            seen.add(card["url"])
            is_fresher = is_fresher_role(
                card["title"], card["experience"], f"{card['location']} fresher entry level"
            )
            salary_range = ""
            if card["salary"]:
                try:
                    annual = int(card["salary"].replace(",", ""))
                    salary_range = f"{annual // 100000} LPA" if annual >= 100000 else card["salary"]
                except ValueError:
                    salary_range = ""
            leads.append({
                "company_name": card["company"],
                "about_company": "",
                "hr_name": "",
                "hr_email": "",
                "company_email": "",
                "hr_mobile": "",
                "company_mobile": "",
                "hr_linkedin_url": "",
                # eLitmus list cards name no poster; the detail page sometimes does —
                # left blank for the hiring-team enrichment tier to fill.
                "posted_by": "",
                "job_title": card["title"][:120],
                "about_job": card["title"],
                "experience_required": card["experience"],
                "employment_type": card["employment"],
                "location": card["location"],
                "salary_range": salary_range,
                "job_url": card["url"],
                "source_site": "elitmus.com",
                "scraped_at": now_iso(),
                "is_fresher": is_fresher,
                "raw_payload": {"title": card["title"], "company": card["company"]},
            })

        self._logger.info(f"eLitmus: scraped {len(leads)} raw leads")
        return leads
