"""
Send worker: consumes send_queue:requests.

Per SRS §8:
- Email send via Resend/Brevo API (if API key configured)
- WhatsApp send via whatsapp-web.js microservice (if session available)
- Checks do_not_contact flag before sending
- Logs to outreach_log table
- Updates pipeline_stage -> 'contacted'

If sending API is unavailable, logs the attempt with status 'failed'.
"""

import json
import asyncio
import logging
import os
from typing import Any

import redis.asyncio as redis
import asyncpg

from .utils.db import get_db_pool
from .api_utils.scoring_client import recompute_lead_score

logger = logging.getLogger(__name__)

UNSUBSCRIBE_FOOTER = """
<hr style="margin-top: 32px; border: none; border-top: 1px solid #e5e7eb;" />
<p style="font-size: 12px; color: #6b7280; line-height: 1.6;">
  You received this email because your company is hiring and we thought HireGen could help.
  If you would prefer not to receive outreach from us,
  <a href="mailto:unsubscribe@hiregen.ai?subject=Unsubscribe&body=Please%20unsubscribe%20me%20from%20 HireGen%20outreach."
     style="color: #2563eb; text-decoration: underline;">click here to unsubscribe</a>.
</p>
<p style="font-size: 12px; color: #9ca3af;">
  HireGen, 123 Innovation Drive, Suite 400, San Francisco, CA 94105
</p>
"""


async def send_email(
    email: str, subject: str, body: str, api_key: str, from_email: str
) -> dict[str, Any]:
    """Send email via Resend or Brevo API."""
    # Try Resend first
    resend_key = api_key if api_key.startswith("re_") else None
    brevo_key = api_key if api_key.startswith("key-") else api_key

    import httpx

    # Try Resend
    if resend_key:
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.post(
                    "https://api.resend.email/v1/emails/send",
                    headers={"Authorization": f"Bearer {resend_key}"},
                    json={
                        "from": from_email,
                        "to": [email],
                        "subject": subject,
                        "html": body,
                    },
                )
                if resp.status_code == 200 or resp.status_code == 202:
                    data = resp.json()
                    return {
                        "status": "sent",
                        "provider": "resend",
                        "provider_message_id": str(data.get("id", "")),
                        "raw": data,
                    }
                logger.warning(f"Resend returned {resp.status_code}: {resp.text}")
        except Exception as e:
            logger.error(f"Resend send failed: {e}")

    # Try Brevo
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                "https://api.brevo.com/v3/smtpEmail",
                headers={
                    "Authorization": f"Bearer {brevo_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "sender": {"email": from_email},
                    "to": [{"email": email}],
                    "subject": subject,
                    "htmlContent": body,
                },
            )
            if resp.status_code == 202 or resp.status_code == 201:
                data = resp.json()
                return {
                    "status": "sent",
                    "provider": "brevo",
                    "provider_message_id": data.get("messageId", ""),
                    "raw": data,
                }
            logger.warning(f"Brevo returned {resp.status_code}: {resp.text}")
    except Exception as e:
        logger.error(f"Brevo send failed: {e}")

    return {"status": "failed", "provider": "unknown", "provider_message_id": None, "raw": {"error": "no provider available"}}


async def send_whatsapp(
    phone: str, message: str, whatsapp_url: str | None = None
) -> dict[str, Any]:
    """Send WhatsApp message via whatsapp-web.js microservice."""
    import httpx

    url = (whatsapp_url or os.environ.get("WHATSAPP_WEB_URL", "http://localhost:3050")) + "/send"

    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                url,
                json={"phone": phone, "message": message},
            )
            if resp.status_code == 200:
                return {"status": "sent", "provider": "whatsapp-web.js", "provider_message_id": str(resp.json().get("id", "")), "raw": resp.json()}
            return {"status": "failed", "provider": "whatsapp-web.js", "provider_message_id": None, "raw": {"error": f"HTTP {resp.status_code}"}}
    except Exception as e:
        logger.error(f"WhatsApp send failed: {e}")
        return {"status": "failed", "provider": "whatsapp-web.js", "provider_message_id": None, "raw": {"error": str(e)}}


async def process_send_job(
    payload: dict[str, Any],
    redis_client: redis.Redis,
    db_pool: asyncpg.Pool,
) -> None:
    """Process a single send job from the queue."""
    lead_id = payload.get("lead_id")
    channel = payload.get("channel", "both")
    draft_id = payload.get("draft_id")
    requested_by = payload.get("requested_by", "system")

    if not lead_id:
        logger.error("Send job missing lead_id")
        return

    logger.info(f"Processing send for lead {lead_id}, channel={channel}")

    async with db_pool.acquire() as conn:
        # Check do_not_contact flag
        do_not_contact = await conn.fetchval(
            "SELECT do_not_contact FROM leads WHERE id = $1",
            lead_id,
        )
        if do_not_contact:
            logger.warning(f"Send blocked: lead {lead_id} is do_not_contact")
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

        # Get lead details
        lead = await conn.fetchrow(
            """
            SELECT l.id, l.email_status, l.whatsapp_status,
                   c.default_email as company_email, c.default_phone as company_phone,
                   hc.personal_email as hr_email, hc.personal_mobile as hr_mobile
            FROM leads l
            JOIN companies c ON l.company_id = c.id
            LEFT JOIN hr_contacts hc ON l.hr_contact_id = hc.id
            WHERE l.id = $1
            """,
            lead_id,
        )

        if not lead:
            logger.warning(f"Lead not found: {lead_id}")
            return

        # Load user-supplied API keys
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

        from_email = os.environ.get("EMAIL_FROM", "leads@hiregen.ai")
        resend_key = api_keys.get("resend") or os.environ.get("RESEND_API_KEY")
        brevo_key = api_keys.get("brevo") or os.environ.get("BREVO_API_KEY")
        email_api_key = resend_key or brevo_key

        # Get draft if draft_id provided
        draft = None
        if draft_id:
            draft = await conn.fetchrow(
                "SELECT subject, body FROM outreach_drafts WHERE id = $1 AND lead_id = $2",
                draft_id,
                lead_id,
            )

        results = []

        # Send email
        if channel in ("email", "both"):
            if lead["email_status"] != "valid" and channel == "email":
                logger.warning(f"Email send blocked: lead {lead_id} email not verified")
                results.append({"channel": "email", "status": "blocked", "reason": "email not verified"})
            else:
                email = lead["hr_email"] or lead["company_email"]
                if not email:
                    results.append({"channel": "email", "status": "failed", "reason": "no email address"})
                else:
                    subject = draft["subject"] if draft else f"Opportunity at {lead_id}"
                    body = (draft["body"] if draft else "") + UNSUBSCRIBE_FOOTER
                    result = await send_email(email, subject, body, email_api_key or "", from_email)
                    results.append({"channel": "email", **result})

                    # Log to outreach_log
                    await conn.execute(
                        """
                        INSERT INTO outreach_log (lead_id, draft_id, channel, sent_by, provider_message_id, delivery_status)
                        VALUES ($1, $2, 'email', $3, $4, $5)
                        """,
                        lead_id,
                        draft_id if draft_id else None,
                        requested_by,
                        result.get("provider_message_id"),
                        result["status"],
                    )

        # Send WhatsApp
        if channel in ("whatsapp", "both"):
            if lead["whatsapp_status"] != "registered" and channel == "whatsapp":
                logger.warning(f"WhatsApp send blocked: lead {lead_id} WhatsApp not verified")
                results.append({"channel": "whatsapp", "status": "blocked", "reason": "whatsapp not verified"})
            else:
                phone = lead["hr_mobile"] or lead["company_phone"]
                if not phone:
                    results.append({"channel": "whatsapp", "status": "failed", "reason": "no phone number"})
                else:
                    message = draft["body"] if draft else ""
                    result = await send_whatsapp(phone, message)
                    results.append({"channel": "whatsapp", **result})

                    await conn.execute(
                        """
                        INSERT INTO outreach_log (lead_id, draft_id, channel, sent_by, provider_message_id, delivery_status)
                        VALUES ($1, $2, 'whatsapp', $3, $4, $5)
                        """,
                        lead_id,
                        draft_id if draft_id else None,
                        requested_by,
                        result.get("provider_message_id"),
                        result["status"],
                    )

        # Update pipeline stage to 'contacted' if any send succeeded
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
            "type": "send_complete",
            "lead_id": lead_id,
            "results": results,
            "timestamp": asyncio.get_event_loop().time(),
        }),
    )

    logger.info(f"Send complete for lead {lead_id}: {results}")


async def consume_send_queue(
    redis_client: redis.Redis,
    db_pool: asyncpg.Pool | None = None,
) -> int:
    """Consume send_queue:requests."""
    if db_pool is None:
        db_pool = await get_db_pool()

    processed = 0
    while True:
        try:
            result = await redis_client.brpop("send_queue:requests", timeout=30)
            if result is None:
                await asyncio.sleep(1)
                continue

            payload = json.loads(result[1])
            await process_send_job(payload, redis_client, db_pool)
            processed += 1
        except json.JSONDecodeError as e:
            logger.error(f"Invalid JSON in send_queue: {e}")
        except Exception as e:
            logger.error(f"Send consumer error: {e}", exc_info=True)
            await asyncio.sleep(5)

    return processed
