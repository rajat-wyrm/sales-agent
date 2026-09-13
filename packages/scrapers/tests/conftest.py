"""Shared DB/Redis fixtures for the real integration + worker tests.

These spin up against live PostgreSQL (DB_URL) and Redis (REDIS_URL), reload the
authoritative schema from manual_schema.sql, and are hermetic per test (drop +
recreate schema, flush redis). No mocks for the database or queue.
"""
import os

import asyncpg
import pytest_asyncio
import redis.asyncio as redis

DB_URL = os.environ.get("DB_URL", "postgresql://postgres:postgres@localhost:5432/leads_db")
REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379/0")

SCHEMA_PATH = os.environ.get(
    "SCHEMA_PATH",
    "/home/rajat/Downloads/sales-agent/packages/api/migrations/manual_schema.sql",
)


def _load_schema():
    with open(SCHEMA_PATH) as f:
        return f.read()


@pytest_asyncio.fixture
async def db_pool():
    pool = await asyncpg.create_pool(DB_URL, min_size=1, max_size=5, command_timeout=30)
    async with pool.acquire() as conn:
        await conn.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public;")
        schema = _load_schema()
        for stmt in schema.split(";"):
            if stmt.strip():
                try:
                    await conn.execute(stmt)
                except Exception:
                    pass
    yield pool
    async with pool.acquire() as conn:
        await conn.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public;")
    await pool.close()


@pytest_asyncio.fixture
async def redis_client():
    os.environ["ENCRYPTION_SECRET"] = "0" * 64
    client = redis.from_url(REDIS_URL, decode_responses=True)
    await client.flushdb()
    yield client
    await client.flushdb()
    await client.close()
