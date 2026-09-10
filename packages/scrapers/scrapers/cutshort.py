"""
Tier 2: CutShort job listings scraper.

CutShort is a curated job platform. Uses Playwright browser automation (SRS §3.3).

Extracts per SRS §4.4 schema.
"""

import json
import re
import asyncio
import logging
from typing import Any

from .base import BaseScraper, ScraperError, now_iso
from .utils.fresher_classifier import is_fresher_role

logger = logging.getLogger(__name__)

BS4_AVAILABLE = True
try:
    from bs4 import BeautifulSoup
except ImportError:
    BS4_AVAILABLE = False


class CutShortScraper(BaseScraper):
    source_name = "cutshort"
    tier = 2
    rate_limit_seconds = 3.0

    API_URL = "https://www.cutshort.io/jobs/fresher-jobs"

    async def _scrape_with_playwright(self, url: str) -> str:
        try:
            from playwright.async_api import async_playwright
            async with async_playwright() as p:
                browser = await p.chromium.launch(headless=True)
                page = await browser.new_page()
                await page.set_extra_http_headers({"User-Agent": self._get_user_agent()})
                await page.goto(url, wait_until="networkidle", timeout=60000)
                content = await page.content()
                await browser.close()
                return content
        except ImportError:
            raise ScraperError("Playwright not installed — required for CutShort (JS-heavy)")
        except Exception as e:
            raise ScraperError(f"Playwright scrape failed: {e}")

    async def scrape(self) -> list[dict[str, Any]]:
        leads: list[dict[str, Any]] = []

        html = await self._scrape_with_playwright(self.API_URL)

        if not BS4_AVAILABLE:
            raise ScraperError("beautifulsoup4 required for CutShort parsing")

        soup = BeautifulSoup(html, "html.parser")

        job_cards = soup.find_all("div", class_=re.compile(r"jobCard|job-card|item-card"))
        if not job_cards:
            job_cards = soup.find_all("a", href=re.compile(r"/jobs/"))

        for card in job_cards[:100]:
            title_elems = card.find_all(attrs={"class": re.compile(r"title|jobTitle|role")})
            job_title = title_elems[0].get_text(strip=True)[:120] if title_elems else ""
            if not job_title:
                link = card.find("a")
                if link:
                    job_title = link.get_text(strip=True)[:120]
                if not job_title:
                    continue

            company_elems = card.find_all(attrs={"class": re.compile(r"company|organization")})
            company_name = company_elems[0].get_text(strip=True)[:80] if company_elems else ""

            link_elem = card.find("a", href=True)
            job_url = link_elem["href"] if link_elem and link_elem.get("href") else ""
            if job_url and not job_url.startswith("http"):
                job_url = f"https://www.cutshort.io{job_url}"

            location_elems = card.find_all(attrs={"class": re.compile(r"location|loc")})
            location = location_elems[0].get_text(strip=True)[:80] if location_elems else ""

            experience_text = job_title + " " + (company_name or "") + " " + location
            is_fresher = is_fresher_role(job_title, "", experience_text.lower())

            lead = {
                "company_name": company_name,
                "about_company": "",
                "hr_name": "",
                "hr_email": "",
                "company_email": "",
                "hr_mobile": "",
                "company_mobile": "",
                "hr_linkedin_url": "",
                "job_title": job_title,
                "about_job": job_title,
                "experience_required": location,
                "salary_range": "",
                "job_url": job_url,
                "source_site": "cutshort.io",
                "scraped_at": now_iso(),
                "is_fresher": is_fresher,
                "raw_payload": {"title": job_title, "url": job_url},
            }
            leads.append(lead)

        self._logger.info(f"CutShort: scraped {len(leads)} raw leads")
        return leads
