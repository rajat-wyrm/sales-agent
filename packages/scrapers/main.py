import os
import json
import asyncio
import logging
from datetime import datetime, timezone
from fastapi import FastAPI, BackgroundTasks
from pydantic import BaseModel
from typing import Optional
import uuid

from scrapers.utils.redis import get_redis
from scrapers.utils.db import get_db_pool

app = FastAPI(
    title="HireGen Scraper Fleet API",
    description="Python worker service for scraping, enrichment, verification, and AI drafting",
    version="0.1.0",
)


class ScrapeRequest(BaseModel):
    sources: Optional[list[str]] = None
    run_type: str = "auto"
    triggered_by: Optional[str] = None


class HealthResponse(BaseModel):
    status: str
    services: dict


@app.get("/health", response_model=HealthResponse)
async def health():
    redis_ok = bool(get_redis())
    try:
        db_pool = await get_db_pool()
        db_ok = bool(db_pool)
    except Exception:
        db_ok = False
    return HealthResponse(
        status="ok",
        services={
            "redis": "configured" if redis_ok else "down",
            "database": "configured" if db_ok else "down",
            "scrapers": [
                "remoteok", "arbeitnow", "remotive", "github_jobs",
                "greenhouse", "lever", "adzuna", "jooble",
                "usajobs", "workday", "smartrecruiters",
                "duckduckgo", "reddit", "twitter", "telegram",
            ],
        },
    )


@app.get("/scrapers")
async def list_scrapers():
    from scrapers.scrape_consumer import SCRAPER_MAP, DEFAULT_SOURCES

    return {
        "available": [
            {"name": name, "module": mod, "tier": _get_tier(name)}
            for name, (mod, _) in SCRAPER_MAP.items()
        ],
        "active": DEFAULT_SOURCES,
    }


def _get_tier(name: str) -> int:
    tier_map = {
        "remoteok": 1, "arbeitnow": 1, "remotive": 1, "github_jobs": 1,
        "adzuna": 1, "jooble": 1, "usajobs": 1,
        "greenhouse": 3, "lever": 3, "workday": 3, "smartrecruiters": 3,
        "linkedin": 2, "naukri": 2, "internshala": 2, "indeed": 2,
        "foundit": 2, "instahyre": 2, "freshersworld": 2,
        "angelist": 2, "glassdoor": 2, "shine": 2, "cutshort": 2,
        "duckduckgo": 4, "reddit": 4, "twitter": 4, "telegram": 4,
        "facebook": 4, "college": 4,
    }
    return tier_map.get(name, 3)


@app.post("/scrape/trigger")
async def trigger_scrape(req: ScrapeRequest):
    redis_client = get_redis()
    run_id = str(uuid.uuid4())
    await redis_client.lpush(
        "scrape_queue:requests",
        json.dumps({
            "run_id": run_id,
            "run_type": req.run_type,
            "sources": req.sources,
            "triggered_by": req.triggered_by,
            "triggered_at": datetime.now(timezone.utc).isoformat(),
        }),
    )
    return {"message": "Scrape job queued", "run_id": run_id}


@app.on_event("startup")
async def startup_event():
    import logging
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )
    asyncio.create_task(start_consumers())


@app.on_event("shutdown")
async def shutdown_event():
    pass


async def start_consumers():
    """Start background queue consumers per SRS §9.1."""
    from scrapers.scrape_consumer import consume_scrape_queue
    from scrapers.normalizer import run_normalizer
    from scrapers.enrichment_worker import consume_enrichment_queue
    from scrapers.verification_worker import consume_verification_queue
    from scrapers.draft_worker import consume_draft_queue
    from scrapers.send_worker import consume_send_queue
    from scrapers.verify_send_worker import consume_verify_send_queue

    redis_client = get_redis()

    try:
        db_pool = await get_db_pool()
    except Exception:
        db_pool = None

    tasks = []
    if redis_client:
        tasks.append(asyncio.create_task(consume_scrape_queue(redis_client, db_pool)))
        tasks.append(asyncio.create_task(run_normalizer(redis_client, db_pool)))

        if db_pool:
            tasks.append(asyncio.create_task(consume_enrichment_queue(redis_client, db_pool)))
            tasks.append(asyncio.create_task(consume_verification_queue(redis_client, db_pool)))
            tasks.append(asyncio.create_task(consume_draft_queue(redis_client, db_pool)))
            tasks.append(asyncio.create_task(consume_send_queue(redis_client, db_pool)))
            tasks.append(asyncio.create_task(consume_verify_send_queue(redis_client, db_pool)))

    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
