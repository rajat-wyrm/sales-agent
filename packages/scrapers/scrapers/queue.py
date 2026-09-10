"""
Redis queue processor for worker coordination.

Per SRS §9.1: every stage (scrape → normalize → score → enrich → verify → draft → send)
is a separate Redis-queue consumer.
"""

import json
import asyncio
import logging
from typing import Any, Callable, Awaitable

import redis.asyncio as redis

logger = logging.getLogger(__name__)


async def enqueue_job(
    redis_client: redis.Redis,
    queue_name: str,
    payload: dict[str, Any],
) -> str:
    """Push a job to a Redis list queue. Returns the job ID (queue length)."""
    job_id = await redis_client.lpush(queue_name, json.dumps(payload))
    logger.info(f"Enqueued job to {queue_name}: {job_id}")
    return str(job_id)


async def dequeue_job(
    redis_client: redis.Redis,
    queue_name: str,
    timeout: int = 5,
) -> tuple[str, dict[str, Any]] | None:
    """Blocking pop from queue. Returns (raw_message, parsed_payload) or None."""
    raw = await redis_client.brpop(queue_name, timeout=timeout)
    if raw is None:
        return None
    msg = json.loads(raw[1])
    return raw[1], msg


async def enqueue_scrape_job(
    redis_client: redis.Redis | None = None,
    sources: list[str] | None = None,
    run_type: str = "auto",
    triggered_by: str | None = None,
) -> str:
    """Enqueue a scrape job per SRS §4.1."""
    if redis_client is None:
        from scrapers.utils.redis import get_redis
        redis_client = get_redis()

    payload = {
        "run_type": run_type,
        "sources": sources,
        "triggered_by": triggered_by,
        "triggered_at": asyncio.get_event_loop().time(),
    }
    return await enqueue_job(redis_client, "scrape_queue:requests", payload)


async def run_queue_consumer(
    redis_client: redis.Redis,
    queue_name: str,
    handler: Callable[[dict[str, Any]], Awaitable[None]],
    timeout: int = 30,
) -> None:
    """Generic queue consumer loop. Runs until cancelled.
    
    Uses BRPOP (blocking pop) which atomically removes the item from the queue.
    No additional LREM needed — BRPOP handles removal.
    """
    logger.info(f"Starting consumer for queue: {queue_name}")
    while True:
        try:
            raw = await redis_client.brpop(queue_name, timeout=timeout)
            if raw is None:
                continue

            payload = json.loads(raw[1])
            await handler(payload)

        except json.JSONDecodeError as e:
            logger.error(f"Invalid JSON in {queue_name}: {e}")
            # Remove the malformed item
            await redis_client.lpop(queue_name)
        except Exception as e:
            logger.error(f"Consumer error in {queue_name}: {e}")
            await asyncio.sleep(5)
