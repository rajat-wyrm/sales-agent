# HireGen — Lead Intelligence Engine

Full-stack lead generation & outreach system: scrape job postings → enrich leads → verify emails → AI-draft outreach → send. Runs **entirely with one command**.

```bash
./up.sh
```

That single command:
1. Starts the SSH server (port 22)
2. Builds all Docker images (API, Web, Workers)
3. Starts the full stack (Postgres, Redis, API, Web, Workers, Reacher, n8n)
4. Applies the database schema automatically (idempotent — safe on every run)

---

## Prerequisites

| Tool | Why | Check |
|---|---|---|
| Docker Engine 24+ | Runs everything | `docker --version` |
| Docker Compose v2 | Orchestrates the stack | `docker compose version` |
| `sudo` access | Starting SSH service (prompts once, only if port 22 is down) | — |

No Node, Python, or Postgres install needed — everything runs in containers.

---

## Quick Start

```bash
# 1. Get the code
git clone https://github.com/rajat-wyrm/sales-agent.git
cd sales-agent

# 2. Configure environment
cp .env.example .env
# Edit .env — at minimum set:
#   JWT_SECRET         (any long random string)
#   ENCRYPTION_SECRET  (min 32 chars — encrypts API keys at rest)
# Optional but recommended: GEMINI_API_KEY, RESEND_API_KEY

# 3. Start EVERYTHING
./up.sh
```

Open **http://localhost:5173** → click **Register** → create your account → you're in.

> **Heads-up:** first `./up.sh` run pulls base images and builds — takes a few minutes. Subsequent runs are fast (cached layers).

---

## Services & Ports

| Service | URL | What it is |
|---|---|---|
| **Web CRM** | http://localhost:5173 | React 18 + Vite + Tailwind — the main UI (nginx serves it, proxies `/api` and `/ws` to the API) |
| **API** | http://localhost:3000 | Fastify (Node 20) — auth, leads, companies, contacts, dashboard, webhooks |
| **API docs (health)** | http://localhost:3000/health | Health check |
| **Workers** | http://localhost:8000/health | FastAPI (Python 3.12) — scraper fleet, enrichment, verification, AI drafts |
| **n8n** | http://localhost:5678 | Workflow orchestration (login: user from `.env`, default `admin` / `change-this-password`) |
| **Reacher** | http://localhost:5050 | Self-hosted email verification |
| **PostgreSQL 16** | localhost:5432 | Database `leads_db` (app) + `n8n` (orchestrator, kept separate to avoid schema clashes) |
| **Redis 7** | localhost:6379 | Queues & cache |
| **SSH** | port 22 | Remote access to the host (password auth = your system password) |

Default DB credentials (local dev only): `postgres` / `postgres`.

---

## The Pipeline (SRS §9)

```
Step 1  Scrape       Scraper fleet (Lever, Greenhouse, Adzuna, Arbeitnow, GitHub internship lists…)
                     → raw leads → Postgres              [n8n cron or manual trigger]

Step 2  Enrich       OSINT enrichment (Snov.io, ContactOut — bring your own keys in Settings)
                     → company + HR contact data         [per-row button in UI]

Step 3  Verify       Email/WhatsApp verification (Reacher self-hosted)
                     → verification_log                  [per-row button in UI]

Step 4  Draft        Gemini AI outreach draft generation
                     → outreach_drafts                   [per-row button in UI]

Step 5  Send         Resend / Brevo email or WhatsApp
                     → outreach_log + webhooks           [per-row button in UI]
```

Steps 2–5 are **on-demand per lead** from the CRM — click a lead, run the step, see the result.

### CRM Pages
**Dashboard** (stats) · **Leads** (filter/score/pipeline) · **Lead Detail** (full record + actions) · **Companies** · **Contacts** · **Duplicates** · **Analytics** · **Settings** (store your Snov.io / ContactOut / Resend keys — encrypted at rest with AES-256-GCM)

---

## Configuration (`.env`)

Copy `.env.example` → `.env`. Key variables:

| Variable | Required | Notes |
|---|---|---|
| `JWT_SECRET` | ✅ | Long random string — signs auth tokens |
| `ENCRYPTION_SECRET` | ✅ | Min 32 chars — encrypts API keys stored in Settings |
| `GEMINI_API_KEY` | for AI drafts | Gemini 2.5 Flash, free tier available |
| `RESEND_API_KEY` / `BREVO_API_KEY` | for sending | Resend 3K/mo or Brevo 300/day free tier |
| `ADZUNA_APP_ID` / `ADZUNA_APP_KEY` | for that scraper | Free registration |
| `SNOVIO_API_KEY` / `CONTACT_OUT_API_KEY` | for enrichment | Can also be set in the Settings page instead |
| `N8N_BASIC_AUTH_USER` / `N8N_BASIC_AUTH_PASSWORD` | n8n login | **Change the default** |
| `WHATSAPP_WEB_URL` | WhatsApp send | Self-hosted whatsapp-web.js instance |

All other variables have sensible defaults for local Docker use. **Never commit `.env`.**

---

## Daily Operations

```bash
./up.sh                          # start everything (idempotent — safe to re-run anytime)
docker compose ps                # see status
docker compose logs -f api       # tail API logs (also: web, workers, n8n, postgres, redis)
docker compose restart api       # restart one service
docker compose down              # stop (data volumes kept)
docker compose down -v           # stop AND wipe databases ⚠️
```

Full rebuild after code changes:
```bash
docker compose up -d --build
```

### Triggering a scrape manually
```bash
curl -X POST http://localhost:8000/scrape/trigger \
  -H 'Content-Type: application/json' -d '{}'
```
Or let n8n run it on a cron schedule.

### Database
```bash
docker compose exec postgres psql -U postgres -d leads_db   # interactive SQL
```
Schema is auto-applied on every `./up.sh` from `packages/api/migrations/manual_schema.sql` (idempotent, `IF NOT EXISTS`). **That file is the source of truth** — append new tables/columns there.

---

## SSH Access

`./up.sh` ensures the SSH server is listening on port 22.

```bash
ssh rajat@<host-ip>        # from another machine on your network
```
- Password auth uses your **system login password**
- For key-based auth, add your public key to `~/.ssh/authorized_keys`
- Find your IP: `ip -4 addr show wlo1 | grep inet`

---

## Architecture

```
┌────────────┐     ┌────────────┐     ┌────────────┐
│  Web (nginx)│────▶│ API Fastify │────▶│ Postgres 16│
│  :5173      │ /api │  :3000      │     │  :5432     │
└────────────┘ /ws  └─────┬──────┘     └────────────┘
                          │ ┌────────────┐
                          ├▶│ Redis 7    │
                          │ │  :6379     │
                          │ └────────────┘
┌────────────┐           │
│ n8n :5678  │──cron────▶┌────────────────┐    ┌──────────┐
└────────────┘           │ Workers FastAPI │───▶│ Reacher  │
   (own n8n DB)          │  :8000         │    │  :5050   │
                         └────────────────┘    └──────────┘
```

### Repo Layout
```
up.sh                        ← THE one command
docker-compose.yml           ← full stack definition
.env / .env.example          ← configuration
packages/
  api/                       ← Fastify API (src/routes: auth, leads, companies,
                               contacts, dashboard, admin, webhooks, ws)
  web/                       ← React CRM (src/pages: Dashboard, Leads, …)
  scrapers/                  ← Python scraper fleet + workers
  api/migrations/            ← manual_schema.sql = canonical DB schema
  n8n/workflows/             ← n8n workflow definitions
docs/                        ← SRS, compliance gate, traceability matrix
.github/workflows/ci.yml     ← CI: tests + image builds (ghcr.io)
```

### Data Flow
Scrapers write raw leads to Postgres via Redis queues → CRM shows them with a computed `lead_score` / `score_band` (hot ≥70, warm ≥40, cold <40) → per-lead enrichment/verification/drafting → outreach with full logging + webhook delivery events.

---

## Development (without Docker)

```bash
# Terminal 1 — infra only
docker compose up -d postgres redis reacher

# Terminal 2 — API (hot reload)
cd packages/api && npm install && npm run dev

# Terminal 3 — Web (Vite dev server, proxies /api → :3000)
cd packages/web && npm install && npm run dev

# Terminal 4 — Workers
cd packages/scrapers && pip install -r requirements.txt && uvicorn main:app --reload
```

### Tests
```bash
cd packages/web && npm test           # jest (Leads, Login, Duplicates)
cd packages/api && npm test         # jest
cd packages/api && npm run lint     # tsc typecheck
cd packages/scrapers && python -m pytest tests/   # scrapers, workers, circuit breaker, robots checker
```
CI (`.github/workflows/ci.yml`) runs these plus Docker image builds (pushed to `ghcr.io`) on every push.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `./up.sh` asks for sudo password | Normal — it needs root to start SSH. Enter your password once. |
| Port already in use (`5432`/`3000`/`5173`…) | A local service conflicts: `docker compose down && sudo systemctl stop postgresql` (or whichever), re-run. |
| `leads` table missing / API 500 on `/api/leads` | `docker compose up -d pg-migrator` — or just re-run `./up.sh` (schema is idempotent). |
| Web loads but login fails | Register first (`/register` in the UI) — there is no seeded default user. |
| n8n login rejected | Credentials come from `N8N_BASIC_AUTH_USER`/`PASSWORD` in `.env`, and `.env` changes need `docker compose up -d n8n`. |
| Gemini drafts fail | `GEMINI_API_KEY` missing/invalid — set it in `.env`, then `docker compose up -d workers api`. |
| Image build stale after editing code | `docker compose up -d --build` (plain `up -d` reuses cached images). |
| Everything is weird | `docker compose down -v && ./up.sh` — nukes and rebuilds from scratch. |

---

## Security Notes

- `.env` holds secrets — it's gitignored; never commit it
- API keys entered in **Settings** are encrypted at rest (AES-256-GCM via `ENCRYPTION_SECRET`)
- Change `N8N_BASIC_AUTH_PASSWORD` and both secrets before any real use
- Postgres/Redis ports are exposed for local dev only — don't do that in prod

## License / Status

Phase 0 (revalidation + pipeline skeleton complete, see `PROGRESS.md`). Built per `HireGen-LeadGen-SRS-v1.0.md` — compliance details in `docs/SRS_COMPLIANCE_GATE.md`.
