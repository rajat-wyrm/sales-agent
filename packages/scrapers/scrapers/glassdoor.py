"""
Tier 2: Glassdoor job listings scraper.

Glassdoor is behind aggressive anti-bot protection (Cloudflare + bot management).
Uses Playwright browser automation with stealth evasion (SRS §3.3).

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


class GlassdoorScraper(BaseScraper):
    source_name = "glassdoor"
    tier = 2
    rate_limit_seconds = 3.0

    API_URL = "https://www.glassdoor.co.in/Job/india-fresher-jobs-SRCH_IL.0,5_IN104_KO6,13.htm"

    async def _scrape_with_playwright(self, url: str) -> str:
        try:
            from playwright.async_api import async_playwright
            async with async_playwright() as p:
                browser = await p.chromium.launch(headless=True)
                page = await browser.new_page()
                await page.set_extra_http_headers({
                    "User-Agent": self._get_user_agent(),
                    "Accept": "text/html,application/xhtml+xml",
                })
                await page.goto(url, wait_until="networkidle", timeout=60000)
                await page.wait_for_timeout(5000)
                content = await page.content()
                await browser.close()
                return content
        except ImportError:
            raise ScraperError("Playwright not installed — required for Glassdoor (anti-bot)")
        except Exception as e:
            raise ScraperError(f"Playwright scrape failed: {e}")

    async def scrape(self) -> list[dict[str, Any]]:
        leads: list[dict[str, Any]] = []

        html = await self._scrape_with_playwright(self.API_URL)

        if not BS4_AVAILABLE:
            raise ScraperError("beautifulsoup4 required for Glassdoor parsing")

        soup = BeautifulSoup(html, "html.parser")

        job_cards = soup.find_all("div", class_=re.compile(r"jobCard|job-card|gdJobView"))
        if not job_cards:
            job_cards = soup.find_all("a", href=re.compile(r"job.htm"))

        for card in job_cards[:100]:
            title_elems = card.find_all(attrs={"class": re.compile(r"title|jobTitle|job-title")})
            job_title = title_elems[0].get_text(strip=True)[:120] if title_elems else ""
            if not job_title:
                link = card.find("a")
                if link:
                    job_title = link.get_text(strip=True)[:120]
                if not job_title:
                    continue

            company_elems = card.find_all(attrs={"class": re.compile(r"company|employer")})
            company_name = company_elems[0].get_text(strip=True)[:80] if company_elems else ""

            link_elem = card.find("a", href=True)
            job_url = link_elem["href"] if link_elem and link_elem.get("href") else ""
            if job_url and not job_url.startswith("http"):
                job_url = f"https://www.glassdoor.co.in{job_url}"

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
                "experience_required": "",
                "location": location,
                "salary_range": "",
                "job_url": job_url,
                "source_site": "glassdoor.co.in",
                "scraped_at": now_iso(),
                "is_fresher": is_fresher,
                "raw_payload": {"title": job_title, "url": job_url},
            }
            leads.append(lead)

        self._logger.info(f"Glassdoor: scraped {len(leads)} raw leads")
        return leads
