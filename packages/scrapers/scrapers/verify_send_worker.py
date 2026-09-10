"""
Verify-and-send worker: consumes verify_send_queue:requests.

Per SRS §8: Combined convenience action that verifies (email + WhatsApp)
then sends if verification passes. If verification fails or service is unavailable,
the lead stays in its current stage and the user is notified via SSE.
"""

import json
import asyncio
import logging
from typing import Any

import redis.asyncio as redis
import asyncpg

from .utils.db import get_db_pool
from .verification_worker import verify_email_reacher, verify_whatsapp
from .send_worker import send_email, send_whatsapp
from .api_utils.scoring_client import recompute_lead_score

logger = logging.getLogger(__name__)


async def process_verify_and_send_job(
    payload: dict[str, Any],
    redis_client: redis.Redis,
    db_pool: asyncpg.Pool,
) -> None:
    """Process a verify-and-send job: verify then send in one atomic flow."""
    lead_id = payload.get("lead_id")
    channel = payload.get("channel", "both")
    draft_id = payload.get("draft_id")
    requested_by = payload.get("requested_by", "system")

    if not lead_id:
        logger.error("Verify-send job missing lead_id")
        return

    logger.info(f"Processing verify-and-send for lead {lead_id}, channel={channel}")

    async with db_pool.acquire() as conn:
        lead = await conn.fetchrow(
            """
            SELECT l.id, l.email_status, l.whatsapp_status, l.do_not_contact,
                   c.default_email as company_email, c.default_phone as company_phone,
                   hc.personal_email as hr_email, hc.personal_mobile as hr_mobile
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

        if lead["do_not_contact"]:
            logger.warning(f"Verify-send blocked: lead {lead_id} is do_not_contact")
            await redis_client.publish(
                f"user:{requested_by}:sse",
                json.dumps({
                    "type": "send_blocked",
                    "lead_id": lead_id,
                    "reason": "do_not_contact",
                    "timestamp": asyncio.get_event_loop().time(),
                }),
            )
            return

        email_to_verify = lead["hr_email"] or lead["company_email"]
        phone_to_verify = lead["hr_mobile"] or lead["company_phone"]

        # Step 1: Verify
        email_status = lead["email_status"]
        whatsapp_status = lead["whatsapp_status"]

        if email_to_verify and channel in ("email", "both"):
            if email_status not in ("valid", "invalid", "catch_all", "disposable"):
                result = await verify_email_reacher(email_to_verify)
                email_status = result["status"]
                await conn.execute(
                    "INSERT INTO verification_log (lead_id, channel, result, raw_response) VALUES ($1, 'email', $2, $3)",
                    lead_id, email_status, json.dumps(result.get("raw", {})),
                )

        if phone_to_verify and channel in ("whatsapp", "both"):
            if whatsapp_status not in ("registered", "not_registered"):
                result = await verify_whatsapp(phone_to_verify)
                whatsapp_status = result["status"]
                await conn.execute(
                    "INSERT INTO verification_log (lead_id, channel, result, raw_response) VALUES ($1, 'whatsapp', $2, $3)",
                    lead_id, whatsapp_status, json.dumps(result.get("raw", {})),
                )

        # Update verification status
        await conn.execute(
            "UPDATE leads SET email_status = $1, whatsapp_status = $2 WHERE id = $3",
            email_status, whatsapp_status, lead_id,
        )

        # Step 2: Send if verification passes
        results = []

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

        import os
        from_email = os.environ.get("EMAIL_FROM", "leads@hiregen.ai")
        email_api_key = api_keys.get("resend") or api_keys.get("brevo") or os.environ.get("RESEND_API_KEY") or os.environ.get("BREVO_API_KEY")

        draft = None
        if draft_id:
            draft = await conn.fetchrow(
                "SELECT subject, body FROM outreach_drafts WHERE id = $1 AND lead_id = $2",
                draft_id, lead_id,
            )

        # Send email if verified
        if channel in ("email", "both") and email_status == "valid":
            email = lead["hr_email"] or lead["company_email"]
            if email:
                subject = draft["subject"] if draft else f"Opportunity"
                body = draft["body"] if draft else ""
                result = await send_email(email, subject, body, email_api_key or "", from_email)
                results.append({"channel": "email", **result})
                await conn.execute(
                    "INSERT INTO outreach_log (lead_id, draft_id, channel, sent_by, provider_message_id, delivery_status) VALUES ($1, $2, 'email', $3, $4, $5)",
                    lead_id, draft_id if draft_id else None, requested_by, result.get("provider_message_id"), result["status"],
                )

        # Send WhatsApp if verified
        if channel in ("whatsapp", "both") and whatsapp_status == "registered":
            phone = lead["hr_mobile"] or lead["company_phone"]
            if phone:
                message = draft["body"] if draft else ""
                result = await send_whatsapp(phone, message)
                results.append({"channel": "whatsapp", **result})
                await conn.execute(
                    "INSERT INTO outreach_log (lead_id, draft_id, channel, sent_by, provider_message_id, delivery_status) VALUES ($1, $2, 'whatsapp', $3, $4, $5)",
                    lead_id, draft_id if draft_id else None, requested_by, result.get("provider_message_id"), result["status"],
                )

        # Update pipeline stage
        any_sent = any(r["status"] == "sent" for r in results)
        if any_sent:
            await conn.execute(
                "UPDATE leads SET pipeline_stage = 'contacted', updated_at = NOW() WHERE id = $1",
                lead_id,
            )

    await recompute_lead_score(db_pool, lead_id)

    await redis_client.publish(
        f"user:{requested_by}:sse",
        json.dumps({
            "type": "verify_send_complete",
            "lead_id": lead_id,
            "email_status": email_status,
            "whatsapp_status": whatsapp_status,
            "results": results,
            "timestamp": asyncio.get_event_loop().time(),
        }),
    )

    logger.info(f"Verify-and-send complete for lead {lead_id}: {results}")


async def consume_verify_send_queue(
    redis_client: redis.Redis,
    db_pool: asyncpg.Pool | None = None,
) -> int:
    """Consume verify_send_queue:requests."""
    if db_pool is None:
        db_pool = await get_db_pool()

    processed = 0
    while True:
        try:
            result = await redis_client.brpop("verify_send_queue:requests", timeout=30)
            if result is None:
                await asyncio.sleep(1)
                continue

            payload = json.loads(result[1])
            await process_verify_and_send_job(payload, redis_client, db_pool)
            processed += 1
        except json.JSONDecodeError as e:
            logger.error(f"Invalid JSON in verify_send_queue: {e}")
        except Exception as e:
            logger.error(f"Verify-send consumer error: {e}", exc_info=True)
            await asyncio.sleep(5)

    return processed
