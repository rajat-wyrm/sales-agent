"""
Tier 3: Lever ATS JSON API scraper.

Pre-flight verified: https://api.lever.co/v0/postings/{company}?mode=json
Returns structured JSON for companies using Lever.
Tested live: Vevo → returns full job data with descriptions.

Companies that DON'T use Lever return {"ok":false,"error":"Document not found"}.
This is expected behavior — we iterate known Lever company slugs.
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



KNOWN_LEVER_COMPANIES = [
    "vevo", "coursera", "asana", "github", "netflix", "shopify",
    "gitlab", "sentry", "hashicorp", "datadog", "segment", "twilio",
    "notion", "slack", "dropbox", "atlassian", "digitalocean",
    "mixpanel", "amplitude", "intercom", "retool", "temporal",
    "anyscale", "weaviate", "langchain", "robinhood", "charter",
    "brex", "calm", "rappi", "auth0", "zapier", "square",
]


class LeverScraper(BaseScraper):
    source_name = "lever"
    tier = 3
    rate_limit_seconds = 0.5

    API_URL_TEMPLATE = "https://api.lever.co/v0/postings/{company}?mode=json&include=description"

    def __init__(self, redis_client=None, db=None, companies: list[str] | None = None):
        super().__init__(redis_client, db)
        self._companies = companies or KNOWN_LEVER_COMPANIES

    async def scrape(self) -> list[dict[str, Any]]:
        leads: list[dict[str, Any]] = []

        async with aiohttp.ClientSession() as session:
            for company in self._companies:
                url = self.API_URL_TEMPLATE.format(company=company)
                try:
                    async with session.get(
                        url,
                        headers={"Accept": "application/json"},
                        timeout=aiohttp.ClientTimeout(total=15),
                    ) as resp:
                        if resp.status == 404:
                            self._logger.debug(f"Lever: {company} not using Lever (404)")
                            continue
                        if resp.status != 200:
                            self._logger.warning(f"Lever: {company} returned {resp.status}")
                            continue

                        text = await resp.text()
                        if text.startswith('{"ok":false'):
                            self._logger.debug(f"Lever: {company} does not use Lever")
                            continue

                        data = json.loads(text)

                    if isinstance(data, dict) and "jobs" in data:
                        jobs = data["jobs"]
                    elif isinstance(data, list):
                        jobs = data
                    elif isinstance(data, dict) and "postings" in data:
                        jobs = data["postings"]
                    else:
                        jobs = [data] if isinstance(data, dict) else []

                    for job in jobs:
                        if not isinstance(job, dict):
                            continue

                        job_title = job.get("title", "") or job.get("text", "") or job.get("openingPlain", "")
                        if not job_title:
                            continue

                        is_fresher = is_fresher_role(job_title, "", json.dumps(job).lower())

                        experience_required = self._extract_experience(job)
                        hr_info = self._extract_hr_info(job)

                        lead = {
                            "company_name": company.capitalize(),
                            "about_company": job.get("company", ""),
                            "hr_name": hr_info.get("name", ""),
                            "hr_email": hr_info.get("email", ""),
                            "company_email": "",
                            "hr_mobile": "",
                            "company_mobile": "",
                            "hr_linkedin_url": hr_info.get("linkedin", ""),
                            "job_title": job_title,
                            "about_job": job.get("descriptionPlain", "") or job.get("descriptionBodyPlain", ""),
                            "experience_required": experience_required,
                            "salary_range": job.get("salaryRange", "") or job.get("salaryDescription", ""),
                            "job_url": job.get("applyUrl", "") or job.get("hostedUrl", ""),
                            "source_site": f"lever.co/{company}",
                            "scraped_at": now_iso(),
                            "is_fresher": is_fresher,
                            "raw_payload": job,
                        }
                        leads.append(lead)

                except json.JSONDecodeError:
                    self._logger.warning(f"Lever: {company} returned non-JSON")
                    continue
                except asyncio.TimeoutError:
                    raise ScraperError(f"Lever API timed out for {company}")
                except aiohttp.ClientError as e:
                    raise ScraperError(f"HTTP error for {company}: {e}")

        self._logger.info(f"Lever: scraped {len(leads)} raw leads")
        return leads

    def _extract_experience(self, job: dict[str, Any]) -> str:
        text = json.dumps(job).lower()
        for pattern in [
            r"\b(\d+[\.\d]*)-(\d+[\.\d]*) years? of experience",
            r"\b(\d+[\.\d]*)-(\d+[\.\d]*) years? experience",
        ]:
            match = re.search(pattern, text)
            if match:
                return f"{match.group(1)}-{match.group(2)} years"
        if is_fresher_role("", "", text):
            return "fresher/0-1 years"
        return ""

    def _extract_hr_info(self, job: dict[str, Any]) -> dict[str, str]:
        result = {}
        for field in ["recruiter_name", "poster_name", "contact_name", "hiring_manager"]:
            val = job.get(field, "")
            if val:
                result["name"] = str(val)
                break
        for field in ["recruiter_email", "contact_email", "email"]:
            val = job.get(field, "")
            if val:
                result["email"] = str(val)
                break
        return result