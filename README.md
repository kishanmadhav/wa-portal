# WhatsApp-Automation

A multi-tenant WhatsApp support portal that turns inbound WhatsApp messages into
Jira tickets, and gives verified operators a conversational Jira assistant
(queries, ticket actions, reminders) in the same chat.

Runs on the **Meta WhatsApp Cloud API**. It was originally built on a self-hosted
OpenWA gateway; that path still exists in the code behind a provider switch but
is no longer used.

---

## What it does

**For customers** — someone messages the business number:

```
customer: hi genie
bot:      Hi! You've reached support. Please describe your issue…
customer: the office printer is jammed
bot:      A support ticket has been created (HGD-142). Do you need any further
          assistance? …
```

The message is classified for relevance, a Jira issue is created, and the ticket
is optionally pushed straight into Service Genie for triage.

**For verified operators** — trusted phone numbers get a Jira assistant instead:

```
operator: how many open tickets?
bot:      There are 12 tickets open.

operator: create a ticket for the VPN being down, high priority
bot:      Ticket created: HGD-143 (High)

operator: remind all operators about the deploy review at 6pm
bot:      Reminder set for 6 operators at 6:00 PM.
```

Operators can query, create, assign, comment, re-prioritise, resolve/reopen,
delete (with confirmation), and set one-off or broadcast reminders — all in
natural language, with follow-up context carried across turns.

---

## Repo layout

```
src/
  server.js                 app entry, route mounting, body parsers
  routes/
    webhook-cloud.js        Meta Cloud API webhook (verify + signature + normalise)
    webhook.js              shared inbound processor + legacy OpenWA webhook
    whatsapp.js             connect / status / link a number to a tenant
    jira.js                 Atlassian OAuth + project selection
    operators.js            verified-operator management
    reminders.js            due-reminder delivery (called by a cron/timer)
    auth.js                 signup / login / sessions
  lib/
    wa.js                   provider router — cloud vs openwa
    whatsapp-cloud.js       Meta Graph API client (send text/template, subscribe)
    openwa.js               legacy OpenWA gateway client
    jira.js                 Jira REST client (search, create, transition, comment…)
    db.js, migrate.js       Postgres access + schema migration

db/schema.sql               tables (users, sessions, conversations, tickets,
                            operators, reminders)
public/                     dashboard, login, signup (static)
deploy/                     Caddyfile, docker-compose, bootstrap + backup scripts
docs/
  cloud-api-migration-plan.md   Embedded Signup / Tech Provider plan for
                                multi-tenant onboarding (partly implemented —
                                see the status table at the top of the file)
```

---

## Architecture

```
WhatsApp user
     │
     ▼
Meta Cloud API ──POST(signed)──►  /whatsapp/cloud/webhook
                                        │  verify X-Hub-Signature-256
                                        │  resolve tenant by phone_number_id
                                        ▼
                                  processInbound(evt)
                                   ├── operator?  → Jira assistant (LLM intent)
                                   └── customer?  → relevance check → create ticket
                                        │
                                        ▼
                                  wa.sendText(session, to, text)
                                        │
                                        ▼
                                  Meta Graph API → user
```

Both providers produce the **same normalised event**, so the business logic is
written once. Swapping providers is a single env var.

---

## Setup

### 1. Prerequisites
- Node 20+, Docker + Docker Compose, a Postgres instance
- A Meta app with the WhatsApp product, a registered phone number, and a
  permanent System User access token
- An Atlassian OAuth app (for Jira)

### 2. Configure

```bash
cp .env.example .env      # then fill in the values
npm install
npm run migrate           # creates/updates the schema
npm start
```

### 3. Point Meta at the webhook

In the Meta App dashboard → WhatsApp → Configuration:

- **Callback URL:** `https://<your-domain>/whatsapp/cloud/webhook`
- **Verify token:** the value of `META_WEBHOOK_VERIFY_TOKEN`
- Subscribe to the **`messages`** field
- Subscribe your app to the WABA:
  `POST /{waba-id}/subscribed_apps`

### 4. Link a number to a tenant

```bash
curl -X POST https://<your-domain>/whatsapp/cloud/link \
  -H 'Content-Type: application/json' --cookie "<session>" -d '{}'
```

With an empty body it links the number from `META_PHONE_NUMBER_ID`. For
multi-tenant Embedded Signup, pass `{ phone_number_id, waba_id, access_token }`
captured from the onboarding popup.

---

## Deployment

`deploy/` holds everything for a single-box Docker deployment:

| File | Purpose |
| --- | --- |
| `docker-compose.prod.yml` | portal + Postgres + Caddy (+ legacy openwa) |
| `Caddyfile` | HTTPS reverse proxy (auto Let's Encrypt) |
| `launch-script.sh` | EC2 user-data: installs Docker |
| `remote-bootstrap.sh` | first-run stack bringup |
| `backup-db.sh` | nightly `pg_dump` → S3 (uses an EC2 instance role) |

Secrets are supplied at runtime via `portal.env` / `compose.env`, which are
**gitignored** — create them on the host from `.env.example`.

---

## Things worth knowing

**The 24-hour window.** The Cloud API only allows free-form messages within 24h
of the user's last inbound message. Outside it you must send a pre-approved
template. Reminders that fire long after a conversation will fail to send until
a template is wired up — see the note in `routes/reminders.js`.

**Token expiry.** Use a permanent System User token. Temporary dashboard tokens
expire in ~24h and sends start failing with `meta_401`.

**Webhook signatures.** Every inbound POST is verified against
`META_APP_SECRET`. If that variable is unset the webhook accepts unverified
requests and logs a warning — fine locally, not acceptable in production.

**Cloud API numbers leave the consumer app.** Once a number is registered to the
Cloud API it can no longer be used in the normal WhatsApp app, and devices that
cached it may briefly show "not on WhatsApp".

---

## Licence

Private. All rights reserved.
