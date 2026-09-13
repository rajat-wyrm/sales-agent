"""
Queue consumer for scrape_queue:requests.

Consumes scrape jobs dispatched by n8n/API, runs the requested scrapers,
and pushes results to raw_leads_queue for normalization.

Per SRS §4.1: n8n cron daily at 02:00 IST triggers this consumer via webhook.
Per SRS §4.6: scrapers push raw records to raw_leads_queue.
"""

import json
import asyncio
import logging
from typing import Any

import redis.asyncio as redis

logger = logging.getLogger(__name__)

SCRAPER_MAP = {
    "remoteok": ("scrapers.remoteok", "RemoteOkScraper"),
    "arbeitnow": ("scrapers.arbeitnow", "ArbeitnowScraper"),
    "remotive": ("scrapers.remotive", "RemotiveScraper"),
    "github_jobs": ("scrapers.github_jobs", "GitHubJobsScraper"),
    "greenhouse": ("scrapers.greenhouse", "GreenhouseScraper"),
    "lever": ("scrapers.lever", "LeverScraper"),
    "adzuna": ("scrapers.adzuna", "AdzunaScraper"),
    "jooble": ("scrapers.jooble", "JoobleScraper"),
    "usajobs": ("scrapers.usajobs", "USAJobsScraper"),
    "workday": ("scrapers.workday", "WorkdayScraper"),
    "smartrecruiters": ("scrapers.smartrecruiters", "SmartRecruitersScraper"),
    "ashby": ("scrapers.ashby", "AshbyScraper"),
    "recruitee": ("scrapers.recruitee", "RecruiteeScraper"),
    "teamtailor": ("scrapers.teamtailor", "TeamtailorScraper"),
    "breezy": ("scrapers.breezy", "BreezyScraper"),
    "duckduckgo": ("scrapers.duckduckgo_search", "DuckDuckGoScraper"),
    "reddit": ("scrapers.reddit_jobs", "RedditScraper"),
    "twitter": ("scrapers.twitter_jobs", "TwitterScraper"),
    "telegram": ("scrapers.telegram_jobs", "TelegramScraper"),
    "naukri": ("scrapers.naukri", "NaukriScraper"),
    "internshala": ("scrapers.internshala", "InternshalaScraper"),
    "indeed": ("scrapers.indeed", "IndeedScraper"),
    "foundit": ("scrapers.foundit", "FounditScraper"),
    "instahyre": ("scrapers.instahyre", "InstahyreScraper"),
    "wellfound": ("scrapers.angelco", "WellfoundScraper"),
    "glassdoor": ("scrapers.glassdoor", "GlassdoorScraper"),
    "shine": ("scrapers.shine", "ShineScraper"),
    "cutshort": ("scrapers.cutshort", "CutShortScraper"),
    "linkedin": ("scrapers.linkedin_jobs", "LinkedInJobsScraper"),
    "freshersworld": ("scrapers.freshersworld", "FreshersworldScraper"),
    "unstop": ("scrapers.unstop", "UnstopScraper"),
    "jobinsider": ("scrapers.jobinsider", "JobinsiderScraper"),
    "iimjobs": ("scrapers.iimjobs", "IimjobsScraper"),
    "timesjobs": ("scrapers.timesjobs", "TimesjobsScraper"),
    "facebook": ("scrapers.facebook_groups", "FacebookGroupsScraper"),
    "whatsapp": ("scrapers.whatsapp_listener", "WhatsAppListener"),
    "college_portals": ("scrapers.spiders.college_placement", "CollegePlacementSpider"),
}
DEFAULT_SOURCES = [
    "remoteok", "github_jobs", "greenhouse", "lever", "naukri", "internshala",
    "indeed", "foundit", "instahyre", "wellfound", "glassdoor", "shine",
    "cutshort", "linkedin", "freshersworld",
    "unstop", "jobinsider", "iimjobs",
    "arbeitnow", "usajobs", "duckduckgo",
    "ashby", "recruitee", "smartrecruiters", "breezy",
    "timesjobs",
]


async def run_scraper(source: str, redis_client: redis.Redis, db=None) -> tuple[int, str | None]:
    """Run a single scraper and enqueue its results.

    Returns (leads_count, error_message).
    """
    import importlib

    scraper_info = SCRAPER_MAP.get(source)
    if not scraper_info:
        return 0, f"Unknown source: {source}"

    module_path, class_name = scraper_info
    try:
        mod = importlib.import_module(module_path)
        scraper_cls = getattr(mod, class_name)
        scraper = scraper_cls(redis_client=redis_client, db=db)

        leads = await scraper.scrape_and_enqueue()
        logger.info(f"Source {source}: scraped and enqueued {leads} leads")
        return leads, None

    except Exception as e:
        logger.error(f"Source {source} failed: {e}", exc_info=True)
        return 0, str(e)


async def consume_scrape_queue(
    redis_client: redis.Redis,
    db_pool=None,
) -> int:
    """Consume scrape jobs from scrape_queue:requests.

    Each job contains:
      - run_id: unique identifier
      - sources: list of source names to scrape (or null for defaults)
      - run_type: 'scheduled' or 'manual'
      - triggered_by: user ID
    """
    processed = 0

    while True:
        try:
            raw = await redis_client.brpop("scrape_queue:requests", timeout=10)
            if raw is None:
                await asyncio.sleep(1)
                continue

            job = json.loads(raw[1])
            run_id = job.get("run_id", "unknown")
            sources = job.get("sources") or DEFAULT_SOURCES
            run_type = job.get("run_type", "manual")
            triggered_by = job.get("triggered_by")

            logger.info(f"Scrape job {run_id} ({run_type}): sources={sources}")

            results: dict[str, Any] = {
                "run_id": run_id,
                "sources_attempted": len(sources),
                "sources_succeeded": 0,
                "sources_failed": [],
                "leads_found": 0,
            }

            async def scrape_source(src: str):
                db = None
                if db_pool:
                    db = await db_pool.acquire()
                try:
                    count, err = await run_scraper(src, redis_client, db)
                    if err:
                        results["sources_failed"].append({"source": src, "error": err})
                    else:
                        results["sources_succeeded"] += 1
                    results["leads_found"] += count
                finally:
                    if db and db_pool:
                        await db_pool.release(db)

            await asyncio.gather(*[scrape_source(s) for s in sources])

            # Persist run report to scrape_runs (§9.6)
            if db_pool:
                async with db_pool.acquire() as conn:
                    await conn.execute(
                        """
                        INSERT INTO scrape_runs
                          (id, started_at, finished_at, sources_attempted,
                           sources_succeeded, sources_circuit_broken, leads_found, leads_deduped, errors)
                        VALUES ($1, NOW(), NOW(), $2, $3, $4, $5, $6, $7)
                        """,
                        run_id,
                        results["sources_attempted"],
                        results["sources_succeeded"],
                        [f["source"] for f in results["sources_failed"]],
                        results["leads_found"],
                        0,
                        json.dumps({
                            "sources": sources,
                            "run_type": run_type,
                            "triggered_by": triggered_by,
                            "errors": results["sources_failed"],
                        }),
                    )

            processed += 1
            logger.info(f"Scrape job {run_id} complete: {results}")

        except json.JSONDecodeError as e:
            logger.error(f"Invalid JSON in scrape_queue: {e}")
        except Exception as e:
            logger.error(f"Consumer error in scrape_queue: {e}", exc_info=True)
            await asyncio.sleep(5)

    return processed
