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
    api_keys: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """OSINT cascade per SRS §4.5.4 — free/public sources first, then (only if the
    record is STILL missing a contact) a per-vendor paid waterfall gated on the
    keys actually configured. Never spends a credit when free data suffices."""
    result: dict[str, Any] = {"source": "osint_fallback", "confidence_score": 30}

    # Tier 1: Verified LinkedIn profile resolution — dork for candidates, READ
    # each public profile via Jina reader, and only accept when the profile's own
    # name matches the target (difflib gate) with company corroboration.
    # Replaces the old "first linkedin.com/in hit" which happily attached a
    # same-named stranger (never-fabricate golden rule, SRS §6.2).
    if hr_name:
        try:
            from .utils.linkedin_osint import resolve_linkedin_profile
            prof = await resolve_linkedin_profile(hr_name, company_name)
            if prof.get("linkedin"):
                result["hr_linkedin_url"] = prof["linkedin"]
                if not result.get("hr_name") and prof.get("name"):
                    result["hr_name"] = prof["name"]
                # confidence_score is 0..100 here; prof confidence is 0..1
                result["confidence_score"] = max(
                    result["confidence_score"], 20 + int(prof["confidence"] * 80)
                )
                logger.info(
                    f"OSINT: verified LinkedIn {prof['linkedin']} "
                    f"(conf {prof['confidence']}, {prof['source']})"
                )
        except Exception as e:  # noqa: BLE001
            logger.warning(f"LinkedIn OSINT resolve failed for {hr_name}@{company_name}: {e}")

    # Tier 2: Generic company contact patterns
    domain = company_domain or company_name.lower().replace(" ", "")

    # Email cascade. GitHub public-commit mining is the best FIRST-PARTY source:
    # a company's public repos expose real staff emails (name + @domain). We fetch
    # those ONCE, then use them two ways:
    #   (a) a direct name-match on a real commit author is our strongest signal
    #       (first-party, self-published), and
    #   (b) even without a person-match, those real addresses are fed to
    #       osint_find_email as `known_company_emails`, so it INFERS the company's
    #       actual local-part pattern instead of guessing blind (SRS §6.1).
    known_company_emails: list[str] = []
    if hr_name and domain:
        try:
            from .utils.github_email_osint import github_company_contacts
            from .utils.linkedin_osint import name_similarity
            gh = await github_company_contacts(domain)
            known_company_emails = gh.get("emails", []) or []
            best, best_sim = None, 0.0
            for c in gh.get("contacts", []):
                sim = name_similarity(hr_name, c.get("name", ""))
                if sim > best_sim:
                    best_sim, best = sim, c
            if best and best_sim >= 0.72:
                result["hr_email"] = best["email"]
                result["method"] = "github_commit_verified"
                result["confidence_score"] = max(result["confidence_score"], 30 + int(0.9 * 40))
                logger.info(f"OSINT: GitHub-verified email {best['email']}")
            elif gh.get("pattern"):
                logger.info(f"OSINT: GitHub learned pattern {gh['pattern']!r} for {domain}")
        except Exception as e:  # noqa: BLE001
            logger.warning(f"GitHub email mining failed for {hr_name}@{domain}: {e}")

    # Pattern-guess fallback (learns real format from known_company_emails above).
    if hr_name and domain and not result.get("hr_email"):
        try:
            from .utils.osint import osint_find_email
            found = await osint_find_email(hr_name, domain, known_company_emails=known_company_emails)
            if found.get("email"):
                result["hr_email"] = found["email"]
                result["method"] = found["method"]
                # 30 (base) + confidence*40 → 0.8→62, 0.7→58, 0.5→50
                result["confidence_score"] = max(
                    result["confidence_score"], 30 + int(found["confidence"] * 40)
                )
                logger.info(
                    f"OSINT: email pattern {found['email']} "
                    f"(conf {found['confidence']}, {found['method']})"
                )
        except Exception as e:
            logger.warning(f"OSINT email discovery failed for {hr_name}@{domain}: {e}")

    # Tier 2a-fallback: multi-engine SERP email-exposure dorking — a published
    # `name@company.com` in an indexed page (roster/PDF/directory) beats a
    # generated-and-MX-confirmed guess. Only tried if nothing above matched.
    if hr_name and domain and not result.get("hr_email"):
        try:
            from .utils.serp_dork import dork_find_email
            sd = await dork_find_email(hr_name, company_name, domain)
            if sd.get("email"):
                result["hr_email"] = sd["email"]
                result["method"] = sd["method"]
                result["confidence_score"] = max(
                    result["confidence_score"], 30 + int(sd["confidence"] * 40)
                )
                logger.info(
                    f"OSINT: SERP-exposed email {sd['email']} (conf {sd['confidence']})"
                )
        except Exception as e:  # noqa: BLE001
            logger.warning(f"SERP email dork failed for {hr_name}@{domain}: {e}")

    # Tier 2b: cert-transparency (crt.sh) + Wayback archival harvest — both key-
    # free public OSINT. crt.sh leaks addresses from cert subjects/SANs and often
    # reveals extra subdomains; Wayback recovers HR emails from *rotated/archived*
    # careers pages that 404 today. Two uses: (a) feed these real addresses into
    # the pattern-inference set, (b) a direct name-match is first-party-ish proof.
    if domain and domain != ".com":
        harvested: list[str] = []
        try:
            from .utils.osint_contacts import crtsh_emails, wayback_emails
            harvested += await crtsh_emails(domain)
            for path in (f"https://www.{domain}/careers", f"https://{domain}/careers"):
                harvested += await wayback_emails(path)
                if harvested:
                    break
        except Exception as e:  # noqa: BLE001
            logger.debug(f"crt.sh/Wayback harvest skipped for {domain}: {e}")
        harvested = [e for e in harvested if e and "@" in e]
        # (a) enrich the pattern-inference corpus with any new real addresses
        known_company_emails = list(dict.fromkeys(known_company_emails + harvested))
        # (b) direct name-match on a leaked/archived address
        if hr_name and harvested and not result.get("hr_email"):
            try:
                from .utils.linkedin_osint import name_similarity
                for em in harvested:
                    local = em.split("@")[0].replace(".", " ").replace("_", " ").replace("-", " ")
                    # require the whole-name tokens to align, not a single letter
                    if name_similarity(hr_name, local) >= 0.72:
                        result["hr_email"] = em
                        result["method"] = "osint_archive_crtsh"
                        result["confidence_score"] = max(result["confidence_score"], 58)
                        logger.info(f"OSINT: crt.sh/Wayback matched {em}")
                        break
            except Exception as e:  # noqa: BLE001
                logger.debug(f"crt.sh/Wayback name-match skipped: {e}")

    generic_emails = [
        f"careers@{domain}.com",
        f"hr@{domain}.com",
        f"jobs@{domain}.com",
        f"recruiting@{domain}.com",
    ]

    # Tier 2c: Gravatar — a free existence+identity oracle for any email we found.
    # A Gravatar profile means the mailbox is real (Google/WordPress verify on
    # signup) and often carries the person's real display name. Used to LIFT
    # confidence and recover a name, never to fabricate an address.
    if result.get("hr_email"):
        try:
            from .utils.osint_contacts import gravatar_lookup
            g = await asyncio.to_thread(gravatar_lookup, result["hr_email"])
            if g.get("verified_email"):
                result["email_exists"] = True
                result["gravatar_photo"] = g.get("gravatar_photo", "")
                if g.get("hr_name") and not result.get("hr_name"):
                    result["hr_name"] = g["hr_name"]
                result["confidence_score"] = min(95, max(result["confidence_score"], 60) + 10)
                logger.info(f"OSINT: Gravatar confirms {result['hr_email']} (+10 conf)")
        except Exception as e:  # noqa: BLE001
            logger.debug(f"Gravatar lookup skipped: {e}")

    # Tier 3: holehe check on company emails
    for email in generic_emails:
        try:
            from .normalizer import run_holehe_check
            holehe_result = await run_holehe_check(email)
            if holehe_result.get("valid"):
                result["company_email"] = email
                # only fall back to a generic inbox as the personal email if the
                # targeted cascade found nothing — never clobber a verified addr.
                if not result.get("hr_email"):
                    result["hr_email"] = email
                result["confidence_score"] = max(result["confidence_score"], 55)
                logger.info(f"OSINT: holehe validated {email}")
                break
        except Exception as e:  # noqa: BLE001
            logger.warning(f"holehe check failed for {email}: {e}")

    # Tier 4 (last resort): PAID waterfall — only when every free tier above
    # failed to find a personal email, and only vendors whose key is configured.
    # Runs cheapest-first and stops at the first hit, so a record costs at most
    # one credit. §6.3: vendor confidence/verified flags are carried through.
    if hr_name and domain and not result.get("hr_email") and (api_keys or _env_vendor_keys()):
        try:
            from .utils.email_providers import paid_email_waterfall
            paid = await paid_email_waterfall(hr_name, domain, api_keys or {})
            if paid.get("hr_email"):
                result["hr_email"] = paid["hr_email"]
                if paid.get("hr_name") and not result.get("hr_name"):
                    result["hr_name"] = paid["hr_name"]
                if paid.get("hr_linkedin_url") and not result.get("hr_linkedin_url"):
                    result["hr_linkedin_url"] = paid["hr_linkedin_url"]
                result["method"] = f"paid_{paid.get('source', 'vendor')}"
                result["source"] = paid.get("source", "paid")
                result["paid_credits"] = int(paid.get("credits", 1))
                # email_providers adapters already report confidence on a 0..100
                # scale (Apollo verified=90, findymail safe=85, ...). Do NOT rescale
                # — clamp. (A prior `* 90` here produced 8100, which defeated the
                # §6.3 no-clobber UPDATE guard and let a paid guess overwrite a
                # verified email.)
                conf = max(0, min(100, int(paid.get("confidence", 60))))
                if paid.get("verified"):
                    conf = max(conf, 85)
                result["confidence_score"] = max(result["confidence_score"], conf)
                logger.info(
                    f"PAID {paid.get('source')}: {paid['hr_email']} "
                    f"(verified={paid.get('verified')})"
                )
        except Exception as e:  # noqa: BLE001
            logger.warning(f"Paid email waterfall failed for {hr_name}@{domain}: {e}")

    return result


def _env_vendor_keys() -> dict[str, str]:
    """Any email-vendor API key present in the environment (module-level fallback)."""
    keys = {}
    for env, slug in (
        ("HUNTER_API_KEY", "hunter"), ("APOLLO_API_KEY", "apollo_io"),
        ("FINDYMAIL_API_KEY", "findymail"), ("PROSPEO_API_KEY", "prospeo"),
        ("LUSHA_API_KEY", "lusha"), ("ROCKETREACH_API_KEY", "rocketreach"),
    ):
        if os.environ.get(env):
            keys[slug] = os.environ[env]
    return keys


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
            SELECT l.id, l.hr_contact_id, l.pipeline_stage,
                   hc.full_name, hc.linkedin_url, hc.personal_email, hc.personal_mobile,
                   c.name as company_name, c.domain
            FROM leads l
            JOIN companies c ON l.company_id = c.id
            LEFT JOIN hr_contacts hc ON l.hr_contact_id = hc.id
            WHERE l.id = $1
            -- Lock only the leads row we mutate. `FOR UPDATE` over the whole
            -- query is illegal because hr_contacts is on the nullable side of
            -- the LEFT JOIN (`FOR UPDATE cannot be applied to the nullable side
            -- of an outer join`).
            FOR UPDATE OF l
            """,
            lead_id,
        )

        if not lead:
            logger.warning(f"Lead not found: {lead_id}")
            return

        # The HR name lives on the joined hr_contacts row (the normalizer never
        # stores it on leads). Empty until a contact is attached — the cascade
        # then infers/looks it up by company + any name we discover.
        hr_name = lead["full_name"] or ""
        company_name = lead["company_name"] or ""
        company_domain = lead["domain"] or ""
        hr_linkedin = lead["linkedin_url"] or ""

        # `requested_by` is a UUID FK to users for manual runs, but scheduled
        # runs pass sentinels like "system"/"daily_scheduler". Coerce to a real
        # UUID (or None) so neither the users lookup nor the enrichment_log
        # FK insert dies on a non-UUID string.
        user_id: Any = None
        try:
            from uuid import UUID
            user_id = UUID(str(requested_by))
        except (ValueError, TypeError):
            user_id = None

        # Load user-supplied API keys from DB (only for a real user run).
        api_keys: dict[str, str] = {}
        user_row = await conn.fetchrow(
            "SELECT api_keys FROM users WHERE id = $1",
            user_id,
        ) if user_id else None
        if user_row and user_row["api_keys"]:
            try:
                from .crypto_utils.decrypt import decrypt_api_key
                encrypted = user_row["api_keys"]
                for k, v in encrypted.items():
                    if isinstance(v, str):
                        try:
                            api_keys[k] = decrypt_api_key(v)
                        except Exception:
                            # decrypt failed — do NOT forward the ciphertext blob
                            # to a vendor as if it were a real key (garbage auth +
                            # potential key-format oracle). Skip this provider.
                            continue
            except Exception:
                pass

        enrichment_result: dict[str, Any] | None = None
        used_provider = "osint_fallback"
        credits_used = 0
        status = "success"

        # Cost-aware order (SRS §4.5.4 + operator rule: free first, paid ONLY for
        # records still missing a contact, and per-record). The cascade runs every
        # free/public source, then fires the paid email waterfall internally as a
        # last resort (Tier 4) only if no free tier produced an address.
        if provider == "auto" or provider in ("osint", "osint_fallback"):
            enrichment_result = await run_osint_enrichment(
                db_pool, company_name, hr_name, company_domain, api_keys
            )
            used_provider = enrichment_result.get("method") or enrichment_result.get(
                "source", "osint_fallback")
            # free tiers -> osint_* ; a per-record paid hit -> paid_<vendor>
            credits_used = int(enrichment_result.get("paid_credits", 0))

        # Step 1: ContactOut API — only when the cascade found nothing usable AND
        # a LinkedIn URL is on file (it keys off the profile) AND a key exists.
        if (
            not enrichment_result or not enrichment_result.get("hr_email")
        ) and provider in ("contactout", "auto"):
            contactout_key = api_keys.get("contactout") or os.environ.get("ACCONTACT_OUT_API_KEY")
            if contactout_key and hr_linkedin:
                result = await call_contactout(hr_linkedin, contactout_key)
                if result:
                    enrichment_result = {**(enrichment_result or {}), **result}
                    used_provider = "contactout"
                    credits_used = 1
                    status = "success"

        # Step 2: Snov.io API — final paid fallback if still no email.
        if (
            not enrichment_result or not enrichment_result.get("hr_email")
        ) and provider in ("snovio", "auto"):
            snovio_key = api_keys.get("snovio") or os.environ.get("SNOVIO_API_KEY")
            snovio_secret = api_keys.get("snovio_secret") or os.environ.get("SNOVIO_API_SECRET")
            if snovio_key and hr_name and company_name:
                result = await call_snovio(hr_name, company_name, company_domain, snovio_key, snovio_secret)
                if result:
                    enrichment_result = {**(enrichment_result or {}), **result}
                    used_provider = "snovio"
                    credits_used = 1
                    status = "success"

        # Explicit single-provider override (operator clicked "enrich via X").
        if provider not in ("auto", "osint", "osint_fallback", "contactout", "snovio"):
            try:
                from .utils.email_providers import enrich_via_apollo_io, enrich_via_hunter, enrich_via_lusha, enrich_via_rocketreach, enrich_via_prospeo, enrich_via_findymail
                _single = {
                    "hunter": enrich_via_hunter, "apollo": enrich_via_apollo_io,
                    "apollo_io": enrich_via_apollo_io, "lusha": enrich_via_lusha,
                    "rocketreach": enrich_via_rocketreach, "prospeo": enrich_via_prospeo,
                    "findymail": enrich_via_findymail,
                }.get(provider)
                if _single:
                    r = await _single(hr_name, company_domain, api_keys.get(provider))
                    if r and r.get("hr_email"):
                        enrichment_result = {**(enrichment_result or {}), **r}
                        used_provider = provider
                        credits_used = 1
                        status = "success"
            except Exception as e:  # noqa: BLE001
                logger.warning(f"explicit provider {provider} failed: {e}")

        if enrichment_result is None or (
            not enrichment_result.get("hr_email")
            and not enrichment_result.get("hr_linkedin_url")
        ):
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
            user_id,                       # NULL for scheduled/sentinel runs
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

            if new_hr_name or new_hr_linkedin or new_hr_email or new_hr_mobile:
                # Create or update HR contact
                if lead["hr_contact_id"]:
                    await conn.execute(
                        """
                        UPDATE hr_contacts
                        SET full_name = COALESCE(full_name, $1),
                            linkedin_url = CASE
                                WHEN linkedin_url IS NULL OR linkedin_url = ''
                                     OR $5 > confidence_score
                                THEN COALESCE($2, linkedin_url) ELSE linkedin_url END,
                            personal_email = CASE
                                WHEN personal_email IS NULL OR personal_email = ''
                                     OR $5 > confidence_score
                                THEN COALESCE($3, personal_email) ELSE personal_email END,
                            personal_mobile = CASE
                                WHEN personal_mobile IS NULL OR personal_mobile = ''
                                     OR $5 > confidence_score
                                THEN COALESCE($4, personal_mobile) ELSE personal_mobile END,
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
            "lead_id": str(lead_id),
            "provider": used_provider,
            "status": status,
            "timestamp": asyncio.get_event_loop().time(),
        }, default=str),
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
