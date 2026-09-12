"""
Tier 2: Indeed India job listings scraper.

Uses Playwright browser automation (SRS §3.3) — Indeed is heavily JS-rendered.

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


class IndeedScraper(BaseScraper):
    source_name = "indeed"
    tier = 2
    rate_limit_seconds = 3.0

    API_URL = "https://www.indeed.co.in/jobs?q=fresher+entry+level+internship&l="

    async def _scrape_with_playwright(self, url: str) -> str:
        try:
            from playwright.async_api import async_playwright
            async with async_playwright() as p:
                browser = await p.chromium.launch(headless=True)
                page = await browser.new_page()
                await page.set_extra_http_headers({"User-Agent": self._get_user_agent()})
                await page.goto(url, wait_until="networkidle", timeout=60000)
                await page.wait_for_selector("body", timeout=10000)
                content = await page.content()
                await browser.close()
                return content
        except ImportError:
            raise ScraperError("Playwright not installed — required for Indeed (JS-heavy)")
        except Exception as e:
            raise ScraperError(f"Playwright scrape failed: {e}")

    async def scrape(self) -> list[dict[str, Any]]:
        leads: list[dict[str, Any]] = []

        html = await self._scrape_with_playwright(self.API_URL)

        if not BS4_AVAILABLE:
            raise ScraperError("beautifulsoup4 required for Indeed parsing")

        soup = BeautifulSoup(html, "html.parser")

        job_cards = soup.find_all("div", attrs={"data-jk": True})
        if not job_cards:
            job_cards = soup.find_all("div", class_=re.compile(r"jobCard|job_seen"))

        for card in job_cards[:100]:
            title_elem = card.find(attrs={"class": re.compile(r"title|jobTitle")})
            if not title_elem:
                title_elem = card
            job_title = title_elem.get_text(strip=True)[:120]
            if not job_title:
                continue

            company_elem = card.find(attrs={"class": re.compile(r"company|company_location")})
            company_name = company_elem.get_text(strip=True)[:80] if company_elem else ""

            link_elem = card.find("a", href=True)
            job_url = link_elem["href"] if link_elem and link_elem.get("href") else ""
            if job_url and not job_url.startswith("http"):
                if job_url.startswith("/"):
                    job_url = f"https://www.indeed.co.in{job_url}"
                else:
                    job_url = f"https://www.indeed.co.in/{job_url}"

            location_elem = card.find(attrs={"class": re.compile(r"location|loc")})
            location = location_elem.get_text(strip=True)[:80] if location_elem else ""

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
                "source_site": "indeed.co.in",
                "scraped_at": now_iso(),
                "is_fresher": is_fresher,
                "raw_payload": {"title": job_title, "url": job_url},
            }
            leads.append(lead)

        self._logger.info(f"Indeed: scraped {len(leads)} raw leads")
        return leads
