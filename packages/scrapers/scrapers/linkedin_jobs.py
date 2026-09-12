"""
Tier 2: LinkedIn Jobs scraper.

LinkedIn is the highest-value source for HR contact data (direct extraction per SRS §4.5.1).
Uses Playwright with stealth configuration to bypass anti-bot measures (SRS §3.3).

Extracts per SRS §4.4 schema, including HR name extraction from job posting metadata.
"""

import json
import re
import asyncio
import logging
from typing import Any

from .base import BaseScraper, ScraperError, now_iso
from .utils.fresher_classifier import is_fresher_role
from .utils.linkedin_hr_extract import extract_hr_from_linkedin_job

logger = logging.getLogger(__name__)

BS4_AVAILABLE = True
try:
    from bs4 import BeautifulSoup
except ImportError:
    BS4_AVAILABLE = False


class LinkedInJobsScraper(BaseScraper):
    source_name = "linkedin"
    tier = 2
    rate_limit_seconds = 5.0

    API_URL = "https://www.linkedin.com/jobs/search/?keywords=fresher%20entry%20level%20intern"

    async def _scrape_with_playwright(self, url: str) -> str:
        """Use Playwright with stealth evasion to render LinkedIn's JS-heavy pages."""
        try:
            from playwright.async_api import async_playwright
            async with async_playwright() as p:
                browser = await p.chromium.launch(headless=True)
                page = await browser.new_page()
                await page.set_extra_http_headers({
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                                  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                    "Accept-Language": "en-US,en;q=0.5",
                    "Accept-Encoding": "gzip, deflate, br",
                    "DNT": "1",
                    "Sec-Fetch-Site": "none",
                    "Sec-Fetch-Mode": "navigate",
                    "Sec-Fetch-Dest": "document",
                    "Cache-Control": "max-age=0",
                    "Upgrade-Insecure-Requests": "1",
                })
                await page.emulate_media_type("screen")
                await page.set_viewport_size({"width": 1920, "height": 1080})
                await page.goto(url, wait_until="networkidle", timeout=60000)
                await page.wait_for_timeout(8000)
                content = await page.content()
                await browser.close()
                return content
        except ImportError:
            raise ScraperError("Playwright not installed — required for LinkedIn (anti-bot)")
        except Exception as e:
            raise ScraperError(f"Playwright scrape failed: {e}")

    async def scrape(self) -> list[dict[str, Any]]:
        leads: list[dict[str, Any]] = []

        html = await self._scrape_with_playwright(self.API_URL)

        if not BS4_AVAILABLE:
            raise ScraperError("beautifulsoup4 required for LinkedIn parsing")

        soup = BeautifulSoup(html, "html.parser")

        # LinkedIn job cards have data-job-id attribute
        job_cards = soup.find_all("div", attrs={"data-job-id": True})
        if not job_cards:
            job_cards = soup.find_all("li", class_=re.compile(r"job-card|results-card"))

        for card in job_cards[:50]:
            link_elem = card.find("a", href=re.compile(r"/jobs/"))
            if not link_elem:
                link_elem = card.find("a", href=True)
            job_url = link_elem["href"] if link_elem and link_elem.get("href") else ""
            if job_url and not job_url.startswith("http"):
                job_url = f"https://www.linkedin.com{job_url}"

            title_elems = card.find_all(attrs={"class": re.compile(r"jobTitle|job-title|title")})
            job_title = title_elems[0].get_text(strip=True)[:120] if title_elems else ""
            if not job_title and link_elem:
                job_title = link_elem.get_text(strip=True)[:120]
            if not job_title:
                continue

            company_elems = card.find_all(attrs={"class": re.compile(r"company|employer|subline")})
            company_name = company_elems[0].get_text(strip=True)[:80] if company_elems else ""

            location_elems = card.find_all(attrs={"class": re.compile(r"location|loc")})
            location = location_elems[0].get_text(strip=True)[:80] if location_elems else ""

            experience_text = job_title + " " + (company_name or "") + " " + location
            is_fresher = is_fresher_role(job_title, "", experience_text.lower())

            hr_name, hr_email, hr_linkedin = extract_hr_from_linkedin_job(
                html, job_url, company_name
            )

            lead = {
                "company_name": company_name,
                "about_company": "",
                "hr_name": hr_name,
                "hr_email": hr_email,
                "company_email": "",
                "hr_mobile": "",
                "company_mobile": "",
                "hr_linkedin_url": hr_linkedin,
                "job_title": job_title,
                "about_job": job_title,
                "experience_required": "",
                "location": location,
                "salary_range": "",
                "job_url": job_url,
                "source_site": "linkedin.com",
                "scraped_at": now_iso(),
                "is_fresher": is_fresher,
                "raw_payload": {"title": job_title, "url": job_url, "company": company_name},
            }
            leads.append(lead)

        self._logger.info(f"LinkedIn: scraped {len(leads)} raw leads")
        return leads
