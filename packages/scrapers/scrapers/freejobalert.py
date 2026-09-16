"""
Tier 1: FreeJobAlert scraper — India government + fresher notifications.

FreeJobAlert's /latest-notifications page is static HTML: one table row per
recruitment notice with post date, recruitment board, post name + vacancy
count, qualification, advt number, last date and a details article link. This
is the only soldier covering the government/PSU/bank fresher segment
(Apprentices, GDS, SSC CHSL, IBPS, Railway Act Apprentice…), where postings
routinely take 10th/12th/Any-Graduate — prime fresher territory no private
board covers.

Rows are capped so one giant page cannot blow the scrape budget.

Extracts per SRS §4.4 schema.
"""

import re
import html as html_lib
import logging
from typing import Any

from .base import BaseScraper, now_iso

logger = logging.getLogger(__name__)


class FreeJobAlertScraper(BaseScraper):
    source_name = "freejobalert"
    tier = 1
    rate_limit_seconds = 2.0

    BASE = "https://www.freejobalert.com"
    LIST_URL = "https://www.freejobalert.com/latest-notifications/"

    # Data rows alternate between these two classes; header uses a third.
    _ROW = re.compile(r'<tr class="lattrbord lat[oe]clr">(.*?)</tr>', re.S)
    _TD = re.compile(r'<td[^>]*>(.*?)</td>', re.S)
    _LINK = re.compile(r'<a[^>]*href="([^"]+)"[^>]*>([^<]*)</a>')
    _TAG = re.compile(r'<[^>]+>')
    _POSTS = re.compile(r'[–-]\s*([\d,]+)\s*posts?', re.I)
    _WS = re.compile(r'\s+')

    # Rows older than this are stale backlog, not live hiring.
    MAX_ROWS = 500

    @classmethod
    def _text(cls, cell: str) -> str:
        return cls._WS.sub(" ", html_lib.unescape(cls._TAG.sub(" ", cell))).strip(" –-|")

    @classmethod
    def parse_rows(cls, html: str) -> list[dict[str, str]]:
        """Pure parser (unit-tested): table rows -> raw notice dicts."""
        out: list[dict[str, str]] = []
        for block in cls._ROW.findall(html)[: cls.MAX_ROWS]:
            cells = cls._TD.findall(block)
            if len(cells) < 7:
                continue
            posted, board, post, qualification, advt, last_date, more = (
                cls._text(c) for c in cells[:7]
            )
            if not post or not board:
                continue
            link_m = cls._LINK.search(cells[6])
            url = link_m.group(1).strip() if link_m else ""
            if url and url.startswith("/"):
                url = cls.BASE + url
            openings = ""
            pm = cls._POSTS.search(post)
            if pm:
                openings = pm.group(1).replace(",", "")
            out.append({
                "posted": posted,
                "board": board,
                "post": post,
                "qualification": qualification,
                "advt": advt,
                "last_date": last_date,
                "url": url,
                "openings": openings,
            })
        return out

    async def scrape(self) -> list[dict[str, Any]]:
        from .utils.http_client import fetch
        from .utils.fresher_classifier import is_fresher_role

        leads: list[dict[str, Any]] = []
        try:
            resp = await fetch(self.LIST_URL, timeout=30, min_engine="curl", max_engine="playwright")
            html = resp.text
        except Exception as e:  # noqa: BLE001
            self._logger.warning(f"FreeJobAlert fetch failed: {e}")
            return leads

        seen: set[str] = set()
        for row in self.parse_rows(html):
            key = row["url"] or (row["board"] + "|" + row["post"])
            if key in seen:
                continue
            seen.add(key)

            blob = f"{row['post']} {row['qualification']} fresher apprentice intern trainee entry level"
            is_fresher = is_fresher_role(row["post"], row["qualification"], blob)
            qualification = row["qualification"]
            experience = "Fresher" if is_fresher else qualification

            try:
                openings: Any = int(row["openings"]) if row["openings"] else None
            except ValueError:
                openings = None

            leads.append({
                "company_name": row["board"],
                "about_company": "",
                "hr_name": "",
                "hr_email": "",
                "company_email": "",
                "hr_mobile": "",
                "company_mobile": "",
                "hr_linkedin_url": "",
                "posted_by": "",
                "job_title": row["post"][:120],
                "about_job": f"{row['post']} — {qualification}".strip(" —"),
                "experience_required": experience,
                "location": "India",
                "openings_count": openings,
                "posted_at": row["posted"],
                "job_url": row["url"],
                "source_site": "freejobalert.com",
                "scraped_at": now_iso(),
                "is_fresher": is_fresher,
                "raw_payload": {
                    "board": row["board"], "advt": row["advt"],
                    "last_date": row["last_date"],
                },
            })

        self._logger.info(f"FreeJobAlert: scraped {len(leads)} raw leads")
        return leads
