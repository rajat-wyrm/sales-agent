"""
Enrichment worker: consumes enrichment_queue:requests.

Per SRS §5.2: ContactOut API first (LinkedIn-URL-first), then Snov.io fallback,
then OSINT cascade (§4.5.4). Never a dead end.

If no API keys are configured, falls back to OSINT tools (holehe, duckduckgo_search)
and marks the result with provider='osint_fallback'.

Updates:
- enrichment_log table (provider, request_payload, response_payload, credits_used, status)
- leads table (pipeline_stage -> 'enriched', hr fields updated)
- Pushes SSE event to user:redis channel
- Recomputes lead score
"""

import json
import asyncio
import logging
import os
from typing import Any

import redis.asyncio as redis
import asyncpg

from .utils.db import get_db_pool, close_db_pool
from .queue import dequeue_job, run_queue_consumer
from .api_utils.scoring_client import recompute_lead_score

logger = logging.getLogger(__name__)


async def call_contactout(hr_linkedin_url: str, api_key: str) -> dict[str, Any] | None:
    """Call ContactOut API with LinkedIn URL. Returns extracted contact data or None."""
    import httpx

    url = "https://api.contactout.com/v3/linkedin"
    params = {"profile:linkedin": hr_linkedin_url}
    headers = {"Authorization": f"Bearer {api_key}"}

    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(url, params=params, headers=headers)
            if resp.status_code != 200:
                logger.warning(f"ContactOut returned {resp.status_code}")
                return None
            data = resp.json()
            return {
                "hr_name": data.get("full_name", ""),
                "hr_email": data.get("email", ""),
                "hr_mobile": data.get("phone", ""),
                "hr_linkedin_url": hr_linkedin_url,
                "confidence_score": 90,
                "source": "contactout",
            }
    except Exception as e:
        logger.error(f"ContactOut API error: {e}")
        return None


async def call_snovio(hr_name: str, company_name: str, company_domain: str, api_key: str, api_secret: str) -> dict[str, Any] | None:
    """Call Snov.io email finder API. Returns extracted contact data or None."""
    import httpx

    # Step 1: Get email
    url = "https://api.snov.io/v2/lead-enrichment"
    headers = {"Authorization": f"Bearer {api_key}"}
    data = {
        "email": "",
        "fullName": hr_name,
        "companyName": company_name,
        "domain": company_domain,
    }

    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(url, headers=headers, data=data)
            if resp.status_code != 200:
                logger.warning(f"Snov.io returned {resp.status_code}")
                return None
            body = resp.json()
            emails = body.get("emails", [])
            if emails:
                return {
                    "hr_name": hr_name,
                    "hr_email": emails[0].get("email", ""),
                    "hr_linkedin_url": "",
                    "confidence_score": 70,
                    "source": "snovio",
                }
    except Exception as e:
        logger.error(f"Snov.io API error: {e}")
        return None
    return None


async def run_osint_enrichment(
    db_pool: asyncpg.Pool,
    company_name: str,
    hr_name: str,
    company_domain: str,
) -> dict[str, Any]:
    """OSINT cascade fallback per SRS §4.5.4: holehe + duckduckgo_search."""
    result: dict[str, Any] = {"source": "osint_fallback", "confidence_score": 30}

    # Tier 1: DuckDuckGo search for HR name + company
    if hr_name:
        try:
            from duckduckgo_search import DDGS

            query = f'"{hr_name}" "{company_name}" site:linkedin.com'
            ddgs = DDGS()
            results = ddgs.text(query, max_results=3)
            for r in results:
                url = r.get("href", "")
                if "linkedin.com/in/" in url:
                    result["hr_linkedin_url"] = url
                    result["confidence_score"] = 50
                    logger.info(f"OSINT: found LinkedIn for {hr_name} at {company_name}")
                    break
        except Exception as e:
            logger.warning(f"DuckDuckGo search failed: {e}")

    # Tier 2: Generic company contact patterns
    domain = company_domain or company_name.lower().replace(" ", "")
    generic_emails = [
        f"careers@{domain}.com",
        f"hr@{domain}.com",
        f"jobs@{domain}.com",
        f"recruiting@{domain}.com",
    ]

    # Tier 3: holehe check on company emails
    for email in generic_emails:
        try:
            from .normalizer import run_holehe_check
            holehe_result = await run_holehe_check(email)
            if holehe_result.get("valid"):
                result["company_email"] = email
                result["hr_email"] = email
                result["confidence_score"] = max(result["confidence_score"], 55)
                logger.info(f"OSINT: holehe validated {email}")
                break
        except Exception as e:
            logger.warning(f"holehe check failed for {email}: {e}")

    return result


async def process_enrichment_job(
    payload: dict[str, Any],
    redis_client: redis.Redis,
    db_pool: asyncpg.Pool,
) -> None:
    """Process a single enrichment job from the queue."""
    lead_id = payload.get("lead_id")
    provider = payload.get("provider", "auto")
    requested_by = payload.get("requested_by", "system")
    requested_at = payload.get("requested_at", "")

    if not lead_id:
        logger.error("Enrichment job missing lead_id")
        return

    logger.info(f"Processing enrichment for lead {lead_id}, provider={provider}")

    async with db_pool.acquire() as conn:
        lead = await conn.fetchrow(
            """
            SELECT l.id, l.hr_name, l.hr_contact_id, l.pipeline_stage,
                   hc.full_name, hc.linkedin_url, hc.personal_email, hc.personal_mobile,
                   c.name as company_name, c.domain
            FROM leads l
            JOIN companies c ON l.company_id = c.id
            LEFT JOIN hr_contacts hc ON l.hr_contact_id = hc.id
            WHERE l.id = $1
            FOR UPDATE
            """,
            lead_id,
        )

        if not lead:
            logger.warning(f"Lead not found: {lead_id}")
            return

        hr_name = lead["full_name"] or lead["hr_name"] or ""
        company_name = lead["company_name"] or ""
        company_domain = lead["domain"] or ""
        hr_linkedin = lead["linkedin_url"] or ""

        # Load user-supplied API keys from DB
        user_row = await conn.fetchrow(
            "SELECT api_keys FROM users WHERE id = $1",
            requested_by,
        )
        api_keys: dict[str, str] = {}
        if user_row and user_row["api_keys"]:
            try:
                from .crypto_utils.decrypt import decrypt_api_key
                encrypted = user_row["api_keys"]
                for k, v in encrypted.items():
                    if isinstance(v, str):
                        try:
                            api_keys[k] = decrypt_api_key(v)
                        except Exception:
                            api_keys[k] = v
            except Exception:
                pass

        enrichment_result: dict[str, Any] | None = None
        used_provider = "osint_fallback"
        credits_used = 0
        status = "success"

        # Step 1: ContactOut API (if HR LinkedIn URL known and key configured)
        if provider in ("contactout", "auto"):
            contactout_key = api_keys.get("contactout") or os.environ.get("ACCONTACT_OUT_API_KEY")
            if contactout_key and hr_linkedin:
                result = await call_contactout(hr_linkedin, contactout_key)
                if result:
                    enrichment_result = result
                    used_provider = "contactout"
                    credits_used = 1
                    status = "success"

        # Step 2: Snov.io API (fallback)
        if not enrichment_result and provider in ("snovio", "auto"):
            snovio_key = api_keys.get("snovio") or os.environ.get("SNOVIO_API_KEY")
            snovio_secret = api_keys.get("snovio_secret") or os.environ.get("SNOVIO_API_SECRET")
            if snovio_key and hr_name and company_name:
                result = await call_snovio(hr_name, company_name, company_domain, snovio_key, snovio_secret)
                if result:
                    enrichment_result = result
                    used_provider = "snovio"
                    credits_used = 1
                    status = "success"

        # Step 3: OSINT cascade fallback (always available)
        if not enrichment_result:
            enrichment_result = await run_osint_enrichment(db_pool, company_name, hr_name, company_domain)
            used_provider = enrichment_result.get("source", "osint_fallback")
            if not enrichment_result.get("hr_email") and not enrichment_result.get("hr_linkedin_url"):
                status = "no_match"

        # Update enrichment_log
        await conn.execute(
            """
            INSERT INTO enrichment_log
              (lead_id, provider, requested_by, request_payload, response_payload, credits_used, status)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            """,
            lead_id,
            used_provider,
            requested_by,
            json.dumps({"provider": provider, "requested_at": requested_at}),
            json.dumps(enrichment_result or {}),
            credits_used,
            status,
        )

        # Update HR contact / lead
        if enrichment_result:
            new_hr_email = enrichment_result.get("hr_email", "")
            new_hr_mobile = enrichment_result.get("hr_mobile", "")
            new_hr_linkedin = enrichment_result.get("hr_linkedin_url", "")
            new_hr_name = enrichment_result.get("hr_name", "")
            confidence = enrichment_result.get("confidence_score", 0)

            if new_hr_name or new_hr_linkedin:
                # Create or update HR contact
                if lead["hr_contact_id"]:
                    await conn.execute(
                        """
                        UPDATE hr_contacts
                        SET full_name = COALESCE($1, full_name),
                            linkedin_url = COALESCE($2, linkedin_url),
                            personal_email = COALESCE($3, personal_email),
                            personal_mobile = COALESCE($4, personal_mobile),
                            confidence_score = GREATEST(confidence_score, $5),
                            updated_at = NOW()
                        WHERE id = $6
                        """,
                        new_hr_name or None,
                        new_hr_linkedin or None,
                        new_hr_email or None,
                        new_hr_mobile or None,
                        confidence,
                        lead["hr_contact_id"],
                    )
                else:
                    hr_id = await conn.fetchval(
                        """
                        INSERT INTO hr_contacts
                          (full_name, linkedin_url, personal_email, personal_mobile,
                           current_company_id, confidence_score)
                        VALUES ($1, $2, $3, $4, $5, $6)
                        RETURNING id
                        """,
                        new_hr_name or None,
                        new_hr_linkedin or None,
                        new_hr_email or None,
                        new_hr_mobile or None,
                        lead["company_id"],
                        confidence,
                    )
                    await conn.execute(
                        "UPDATE leads SET hr_contact_id = $1 WHERE id = $2",
                        hr_id,
                        lead_id,
                    )

        # Update pipeline stage
        await conn.execute(
            "UPDATE leads SET pipeline_stage = 'enriched', updated_at = NOW() WHERE id = $1",
            lead_id,
        )

    # Recompute lead score
    await recompute_lead_score(db_pool, lead_id)

    # Publish SSE event
    await redis_client.publish(
        f"user:{requested_by}:sse",
        json.dumps({
            "type": "enrichment_complete",
            "lead_id": lead_id,
            "provider": used_provider,
            "status": status,
            "timestamp": asyncio.get_event_loop().time(),
        }),
    )

    logger.info(f"Enrichment complete for lead {lead_id}: provider={used_provider}, status={status}")


async def handle_enrichment_job(payload: dict[str, Any], redis_client: redis.Redis, db_pool: asyncpg.Pool) -> None:
    """Handler wrapper for enrichment_queue consumer."""
    await process_enrichment_job(payload, redis_client, db_pool)


async def consume_enrichment_queue(
    redis_client: redis.Redis,
    db_pool: asyncpg.Pool | None = None,
) -> int:
    """Consume enrichment_queue:requests."""
    if db_pool is None:
        db_pool = await get_db_pool()

    processed = 0
    while True:
        try:
            result = await redis_client.brpop("enrichment_queue:requests", timeout=30)
            if result is None:
                await asyncio.sleep(1)
                continue

            payload = json.loads(result[1])
            await handle_enrichment_job(payload, redis_client, db_pool)
            processed += 1
        except json.JSONDecodeError as e:
            logger.error(f"Invalid JSON in enrichment_queue: {e}")
        except Exception as e:
            logger.error(f"Enrichment consumer error: {e}", exc_info=True)
            await asyncio.sleep(5)

    return processed
