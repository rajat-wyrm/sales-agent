"""
Daily scrape scheduler — stdlib asyncio only (no APScheduler/cron dependency).

The whole pipeline is queue-driven: something must push a job onto
`scrape_queue:requests` or the fleet never runs. Today that only happens via the
HTTP trigger endpoint. This module adds the missing heartbeat: on startup it
schedules a full-fleet scrape every day at a fixed UTC hour and, optionally, a
one-shot catch-up run at boot if none happened recently.

Runs inside the existing FastAPI event loop (started from main.start_consumers),
so it shares the Redis client and adds zero new processes.
"""

from __future__ import annotations

import os
import json
import uuid
import asyncio
import logging
from datetime import datetime, timezone, timedelta

logger = logging.getLogger(__name__)

REQUEST_QUEUE = "scrape_queue:requests"
# Set ENABLE_DAILY_SCHEDULER=0 to disable (e.g. in tests or when an external
# cron/n8n already drives runs). Hour/minute configurable.
_ENABLED = os.environ.get("ENABLE_DAILY_SCHEDULER", "1") != "0"
_HOUR = int(os.environ.get("DAILY_SCRAPE_HOUR", "3"))
_MINUTE = int(os.environ.get("DAILY_SCRAPE_MINUTE", "0"))
_CATCHUP_AT_BOOT = os.environ.get("DAILY_SCRAPE_CATCHUP", "0") == "1"


def _next_run(at: datetime) -> datetime:
    target = at.replace(hour=_HOUR, minute=_MINUTE, second=0, microsecond=0)
    if target <= at:
        target += timedelta(days=1)
    return target


async def _enqueue(redis_client, sources: list[str] | None = None) -> str:
    run_id = str(uuid.uuid4())
    await redis_client.lpush(
        REQUEST_QUEUE,
        json.dumps({
            "run_id": run_id,
            "run_type": "scheduled",
            "sources": sources,          # None -> consumer uses DEFAULT_SOURCES
            "triggered_by": "daily_scheduler",
            "triggered_at": datetime.now(timezone.utc).isoformat(),
        }),
    )
    return run_id


async def daily_scrape_scheduler(redis_client, sources: list[str] | None = None) -> None:
    """Forever-loop: enqueue one full-fleet scrape per day at the configured time."""
    if redis_client is None or not _ENABLED:
        logger.info("Daily scheduler disabled (no redis or ENABLE_DAILY_SCHEDULER=0)")
        return

    if _CATCHUP_AT_BOOT:
        try:
            run_id = await _enqueue(redis_client, sources)
            logger.info(f"Boot catch-up scrape enqueued: {run_id}")
        except Exception as e:  # noqa: BLE001
            logger.warning(f"Boot catch-up enqueue failed: {e}")

    while True:
        now = datetime.now(timezone.utc)
        nxt = _next_run(now)
        wait = (nxt - now).total_seconds()
        logger.info(f"Daily scrape scheduled for {nxt.isoformat()} (in {int(wait)}s)")
        try:
            await asyncio.sleep(wait)
        except asyncio.CancelledError:
            raise
        try:
            run_id = await _enqueue(redis_client, sources)
            logger.info(f"Scheduled daily scrape enqueued: {run_id}")
        except Exception as e:  # noqa: BLE001
            # ponytail: a missed day self-heals next tick; alert path if it matters
            logger.error(f"Daily scheduler enqueue failed: {e}")
            await asyncio.sleep(60)
