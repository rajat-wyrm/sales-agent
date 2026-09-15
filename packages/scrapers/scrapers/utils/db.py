import os
import asyncpg
import logging

logger = logging.getLogger(__name__)

_pool: asyncpg.Pool | None = None


# Consumers that need a connection at once: ENRICH_CONCURRENCY (default 4) +
# NORMALIZER_CONCURRENCY (default 5) + verification/draft/send/verify_send/scrape
# + the daily scheduler. At the old fixed ceiling of 10 they contended, and
# because workers held a connection across vendor HTTP calls (30s timeouts), one
# slow Snov.io response could starve everyone. Sized from the actual consumer
# count so it cannot silently fall behind a concurrency increase.
def _pool_max() -> int:
    try:
        enrich = int(os.environ.get("ENRICH_CONCURRENCY", "4") or 4)
    except ValueError:
        enrich = 4
    try:
        norm = int(os.environ.get("NORMALIZER_CONCURRENCY", "5") or 5)
    except ValueError:
        norm = 5
    # +6 for the single-instance consumers and headroom; capped well under
    # Postgres max_connections (100) even alongside the API's own pool.
    return max(10, min(40, enrich + norm + 6))


async def init_db(db_url: str) -> asyncpg.Pool:
    """Initialize database connection pool with the given URL."""
    pool = await asyncpg.create_pool(
        db_url,
        min_size=2,
        max_size=_pool_max(),
        command_timeout=30,
    )
    return pool


async def get_db_pool() -> asyncpg.Pool:
    """Get or create the postgres connection pool."""
    global _pool
    if _pool is None:
        db_url = os.environ.get("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/leads_db")
        _pool = await init_db(db_url)
    return _pool


async def close_db_pool():
    global _pool
    if _pool:
        await _pool.close()
        _pool = None
