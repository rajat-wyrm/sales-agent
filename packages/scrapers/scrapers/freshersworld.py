"""
Tier 2: Freshersworld job listings scraper.

Fetches fresher job listings from https://www.freshersworld.com/jobs/.
Parses server-rendered HTML to extract job postings.

Extracts per SRS §4.4 schema.
"""

import json
import re
import asyncio
import aiohttp
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


class FreshersworldScraper(BaseScraper):
    source_name = "freshersworld"
    tier = 2
    rate_limit_seconds = 2.0

    API_URL = "https://www.freshersworld.com/jobs/"

    async def scrape(self) -> list[dict[str, Any]]:
        leads: list[dict[str, Any]] = []

        headers = {"User-Agent": self._get_user_agent()}

        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(self.API_URL, headers=headers,
                                       timeout=aiohttp.ClientTimeout(total=30)) as resp:
                    if resp.status != 200:
                        raise ScraperError(f"Freshersworld returned {resp.status}")
                    html = await resp.text()
        except asyncio.TimeoutError:
            raise ScraperError("Freshersworld timed out")
        except aiohttp.ClientError as e:
            raise ScraperError(f"HTTP error: {e}")

        if not BS4_AVAILABLE:
            raise ScraperError("beautifulsoup4 is required for Freshersworld parsing")

        soup = BeautifulSoup(html, "html.parser")

        job_cards = soup.find_all("div", class_="job-detail")
        if not job_cards:
            job_cards = soup.find_all("div", attrs={"class": re.compile(r"job|opening|listing")})

        for card in job_cards[:200]:
            link_elem = card.find("a", href=True)
            if not link_elem:
                continue

            job_title = link_elem.get_text(strip=True) or ""
            company_elem = card.find(attrs={"class": re.compile(r"company|employer|org")})
            company_name = company_elem.get_text(strip=True) if company_elem else ""

            if not job_title or "Page" in job_title:
                continue

            job_url = link_elem["href"]
            if job_url and not job_url.startswith("http"):
                job_url = f"https://www.freshersworld.com{job_url}"

            experience_text = job_title + " " + (company_name or "") + " " + html[:200]
            is_fresher = is_fresher_role(job_title, "", experience_text.lower())

            location_elem = card.find(attrs={"class": re.compile(r"location|loc")})
            location = location_elem.get_text(strip=True) if location_elem else ""

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
                "source_site": "freshersworld.com",
                "scraped_at": now_iso(),
                "is_fresher": is_fresher,
                "raw_payload": {"title": job_title, "company": company_name, "url": job_url},
            }
            leads.append(lead)

        self._logger.info(f"Freshersworld: scraped {len(leads)} raw leads")
        return leads
