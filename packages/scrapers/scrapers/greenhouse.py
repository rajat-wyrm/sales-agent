"""
Tier 3: Greenhouse ATS JSON API scraper.

Pre-flight verified: https://boards-api.greenhouse.io/v1/boards/{company}/jobs
Returns structured JSON for any company using Greenhouse as their ATS.
Tested live: Stripe → 100+ jobs, Airbnb → 100+ jobs, Nike → 404 (not using Greenhouse).

The SRS §4.53 mentions Greenhouse as a Tier 3 ATS. To discover which companies use
Greenhouse, we iterate a known company slug list (can be expanded over time).
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

KNOWN_GREENHOUSE_COMPANIES = [
    "stripe", "airbnb", "reddit", "doordash", "notion", "figma",
    "slack", "dropbox", "asana", "gitlab", "sentry", "hashicorp",
    "elastic", "mongodb", "datadog", "segment", "twilio", "shopify",
    "coursera", "robinhood", "square", "charter", "brex", "notion",
    "calm", "bloomreach", "ginkgo", "rappi", "auth0", "zapier",
    "digitalocean", "elastic", "elastic", "hubspot", "atlassian",
    "intercom", "mixpanel", "amplitude", "segment", "retool",
    "temporal", "anyscale", "weaviate", "langchain",
]


class GreenhouseScraper(BaseScraper):
    source_name = "greenhouse"
    tier = 3
    rate_limit_seconds = 0.5

    API_URL_TEMPLATE = "https://boards-api.greenhouse.io/v1/boards/{company}/jobs"

    def __init__(self, redis_client=None, db=None, companies: list[str] | None = None):
        super().__init__(redis_client, db)
        self._companies = companies or KNOWN_GREENHOUSE_COMPANIES

    async def scrape(self) -> list[dict[str, Any]]:
        leads: list[dict[str, Any]] = []

        async with aiohttp.ClientSession() as session:
            for company in self._companies:
                url = self.API_URL_TEMPLATE.format(company=company)
                try:
                    async with session.get(
                        url,
                        headers={"User-Agent": "HireGen-LeadGen/1.0"},
                        timeout=aiohttp.ClientTimeout(total=15),
                    ) as resp:
                        if resp.status == 404:
                            self._logger.debug(f"Greenhouse: {company} not using Greenhouse (404)")
                            continue
                        if resp.status != 200:
                            self._logger.warning(f"Greenhouse: {company} returned {resp.status}")
                            continue

                        data = await resp.json()

                    if isinstance(data, dict) and "jobs" in data:
                        jobs = data["jobs"]
                    elif isinstance(data, list):
                        jobs = data
                    else:
                        jobs = []

                    for job in jobs:
                        if not isinstance(job, dict):
                            continue

                        job_title = job.get("title", "")
                        if not job_title:
                            continue

                        is_fresher = is_fresher_role(job_title, "", json.dumps(job).lower())

                        # Extract HR/posted-by info from job details
                        hr_info = self._extract_hr_info(job)
                        experience_required = self._extract_experience(job)

                        lead = {
                            "company_name": company,
                            "about_company": "",
                            "hr_name": hr_info.get("name", ""),
                            "hr_email": hr_info.get("email", ""),
                            "company_email": "",
                            "hr_mobile": "",
                            "company_mobile": "",
                            "hr_linkedin_url": hr_info.get("linkedin", ""),
                            "job_title": job_title,
                            "about_job": job.get("content", ""),
                            "experience_required": experience_required,
                            "location": (job.get("location") or {}).get("name", "") if isinstance(job.get("location"), dict) else (job.get("location") or ""),
                            "salary_range": job.get("metadata", {}).get("salary_range", "") if isinstance(job.get("metadata"), dict) else "",
                            "job_url": job.get("absolute_url", ""),
                            "source_site": f"greenhouse.io/{company}",
                            "scraped_at": now_iso(),
                            "is_fresher": is_fresher,
                            "raw_payload": job,
                        }
                        leads.append(lead)

                except asyncio.TimeoutError:
                    raise ScraperError(f"Greenhouse API timed out for {company}")
                except aiohttp.ClientError as e:
                    raise ScraperError(f"HTTP error for {company}: {e}")

        self._logger.info(f"Greenhouse: scraped {len(leads)} raw leads")
        return leads

    def _extract_hr_info(self, job: dict[str, Any]) -> dict[str, str]:
        """Extract HR name/contact from job posting metadata per SRS §4.5."""
        result = {}

        # Check for recruiter/hiring manager fields in job metadata
        for field in ["recruiter_name", "posted_by", "hiring_manager", "contact_name"]:
            val = job.get(field, "")
            if val:
                result["name"] = str(val)
                break

        for field in ["recruiter_email", "contact_email", "hiring_manager_email"]:
            val = job.get(field, "")
            if val:
                result["email"] = str(val)
                break

        for field in ["recruiter_linkedin", "contact_linkedin"]:
            val = job.get(field, "")
            if val:
                result["linkedin"] = str(val)
                break

        return result

    def _extract_experience(self, job: dict[str, Any]) -> str:
        """Extract experience requirements per SRS §4.2."""
        text_fields = [
            job.get("content", ""),
            job.get("description", ""),
            job.get("requirements", ""),
            json.dumps(job),
        ]
        combined = " ".join(str(f) for f in text_fields if f).lower()

        for pattern in [
            r"\b(\d+[\.\d]*)-(\d+[\.\d]*) years? of experience",
            r"\b(\d+[\.\d]*)-(\d+[\.\d]*) years? experience",
            r"\b(\d+) years? of relevant experience",
        ]:
            match = re.search(pattern, combined)
            if match:
                return f"{match.group(1)}-{match.group(2)} years"

        if is_fresher_role("", "", combined):
            return "fresher/0-1 years"

        return ""

