"""
Tier 3: SmartRecruiters public API scraper.

SRS §4.3 lists SmartRecruiters as a Tier-3 ATS source.
API endpoint: api.smartrecruiters.com/v1/companies/{company}/postings
"""

import json
import asyncio
import aiohttp
import logging
from typing import Any

from .base import BaseScraper, ScraperError, now_iso
from .utils.fresher_classifier import is_fresher_role

logger = logging.getLogger(__name__)

KNOWN_SMARTRECRUITERS_COMPANIES = [
    "google", "apple", "amazon", "meta", "microsoft",
    "netflix", "airbnb", "uber", "lyft", "shopify",
    "salesforce", "twilio", "datadog", "segment", "hashicorp",
    "elastic", "mongodb", "gitlab", "docker", "redis",
    "mongodb", "couchbase", "neo4j", "elastic", "splunk",
    "atlassian", "slack", "dropbox", "notion", "figma",
    "coursera", "byju", "unacademy", "policybazaar", "zomato",
]


class SmartRecruitersScraper(BaseScraper):
    source_name = "smartrecruiters"
    tier = 3
    rate_limit_seconds = 0.5

    API_URL_TEMPLATE = "https://api.smartrecruiters.com/v1/companies/{company}/postings"

    def __init__(self, redis_client=None, db=None, companies: list[str] | None = None):
        super().__init__(redis_client, db)
        self._companies = companies or KNOWN_SMARTRECRUITERS_COMPANIES

    async def scrape(self) -> list[dict[str, Any]]:
        leads: list[dict[str, Any]] = []

        async with aiohttp.ClientSession() as session:
            for company in self._companies:
                url = self.API_URL_TEMPLATE.format(company=company)
                try:
                    async with session.get(
                        url,
                        headers={"User-Agent": "HireGen-LeadGen/1.0", "Accept": "application/json"},
                        timeout=aiohttp.ClientTimeout(total=15),
                    ) as resp:
                        if resp.status == 404:
                            self._logger.debug(f"SmartRecruiters: {company} not found (404)")
                            continue
                        if resp.status != 200:
                            self._logger.warning(f"SmartRecruiters: {company} returned {resp.status}")
                            continue

                        data = json.loads(await resp.text())

                        if isinstance(data, dict) and "content" in data:
                            jobs = data["content"]
                        elif isinstance(data, list):
                            jobs = data
                        else:
                            jobs = []

                        for job in jobs:
                            if not isinstance(job, dict):
                                continue

                            job_title = job.get("title", job.get("name", ""))
                            if not job_title:
                                continue

                            is_fresher = is_fresher_role(
                                job_title,
                                job.get("experienceLevel", ""),
                                json.dumps(job).lower(),
                            )

                            lead = {
                                "company_name": company.capitalize(),
                                "about_company": "",
                                "hr_name": "",
                                "hr_email": "",
                                "company_email": "",
                                "hr_mobile": "",
                                "company_mobile": "",
                                "hr_linkedin_url": "",
                                "job_title": job_title,
                                "about_job": job.get("jobDescription", job.get("description", "")),
                                "experience_required": job.get("experienceLevel", ""),
                                "salary_range": "",
                                "job_url": job.get("link", job.get("applyUrl", job.get("url", ""))),
                                "source_site": f"smartrecruiters.com/{company}",
                                "scraped_at": now_iso(),
                                "is_fresher": is_fresher,
                                "raw_payload": job,
                            }
                            leads.append(lead)

                except json.JSONDecodeError:
                    self._logger.warning(f"SmartRecruiters: {company} returned non-JSON")
                    continue
                except asyncio.TimeoutError:
                    raise ScraperError(f"SmartRecruiters API timed out for {company}")
                except aiohttp.ClientError as e:
                    raise ScraperError(f"HTTP error for {company}: {e}")

        self._logger.info(f"SmartRecruiters: scraped {len(leads)} raw leads")
        return leads
