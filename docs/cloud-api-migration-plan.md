> **Status note (added when this was moved into the repo).**
>
> This plan was written before the Cloud API migration. Its current state:
>
> | Section | Status |
> | --- | --- |
> | 1. Meta setup (Business, App, verification) | **Done** — app "LAMP", business verified |
> | 1.4 Tech Provider / 1.5 App Review | **Not done** — required for Embedded Signup |
> | 2. Database schema | **Done** — see `wa-portal/db/schema.sql` (`phone_number_id`, `waba_id`, `access_token`, `provider`) |
> | 3. Webhook adapter | **Done** — see `wa-portal/src/routes/webhook-cloud.js` |
> | 4. Embedded Signup UI | **Not done** — this is the remaining multi-tenant work |
> | 5. Reusing existing code | **Done** — `wa-portal/src/lib/wa.js` routes cloud vs openwa |
> | 6. Environment variables | **Done** — see `wa-portal/.env.example` |
> | 8. Cost / pricing | Still useful reference |
>
> The live system runs a **single** production number. The sections still worth
> reading are **1.4, 1.5, 4, 7, 8** — the path to letting each customer bring
> their own number.

---

# WhatsApp Cloud API — Multi-Tenant Migration Plan

**Goal:** Let each customer connect *their own* WhatsApp Business number through
Service Genie. Messages to a customer's number create tickets in *that
customer's* Jira. No QR scans, no phone staying online, no ban risk.

This replaces the OpenWA self-hosted gateway with Meta's official
**WhatsApp Cloud API**, using **Embedded Signup** so customers onboard
themselves, with you acting as a **Meta Tech Provider**.

---

## 0. The big picture

```
Customer clicks "Connect WhatsApp" in Service Genie
        │
        ▼
Meta Embedded Signup popup (Facebook-login style)
   customer logs into THEIR Meta Business
   selects/creates their WhatsApp Business number
   grants your app permission
        │
        ▼
Your backend receives: WABA id + phone_number_id + a token
   stored against their org in Supabase (whatsapp_connections)
        │
        ▼
Customer's number ──msg──> Meta ──webhook──> YOUR backend
   look up which org owns that phone_number_id
   create a ticket in THAT org's Jira
   (optionally) reply back via Cloud API
```

The chatbot logic you already built (org context, OpenAI relevance, Jira
ticket creation) **transfers almost unchanged** — only the message *source*
(Meta webhook instead of OpenWA webhook) and the *send* call (Meta Graph API
instead of OpenWA send-text) differ.

---

## 1. What YOU set up at Meta (the long pole — 2–4 weeks)

These are gated on Meta's approval timelines, not on code. Start them early
and in parallel with the build.

### 1.1 Meta Business Account
- Go to https://business.facebook.com → create a Business Account if you don't
  have one. Use a real business name (Agentic Genie / Service Genie).

### 1.2 Meta App
- Go to https://developers.facebook.com → My Apps → Create App
- Type: **Business**
- Add the **WhatsApp** product to the app.
- This immediately gives you:
  - A **test phone number** (Meta-provided, free) — you can send/receive on it
    NOW, no verification needed. **This is what we build against first.**
  - A **temporary access token** (24h) for testing.
  - An app id + app secret (you'll need these).

### 1.3 Business Verification  (~1–5 business days)
- In the Meta App dashboard → Settings → Business Verification.
- Submit business documents (registration, address, etc.).
- Required before real customers can connect their numbers.

### 1.4 Become a Tech Provider  (so customers onboard through you)
- This is the model where customers connect THEIR OWN numbers via your app.
- In the WhatsApp product → configure **Embedded Signup**.
- You'll register an **OAuth redirect / Facebook Login for Business**
  configuration.

### 1.5 App Review  (~1–2 weeks)
- Before Embedded Signup works for real (non-test) users, Meta reviews your app.
- Permissions you'll request:
  - `whatsapp_business_management`
  - `whatsapp_business_messaging`
  - `business_management`
- Provide a screencast of your "Connect WhatsApp" flow + privacy policy URL
  (you already have privacy.html on the landing page).

### 1.6 A system-user token for your app
- In Business Settings → System Users → create a system user, generate a
  long-lived token with the WhatsApp permissions. This is YOUR app's token
  (separate from each customer's). Used for some management calls.

**Prerequisites checklist:**
- [ ] Meta Business Account
- [ ] Meta App (Business type) with WhatsApp product
- [ ] App id + app secret recorded
- [ ] Test number working (immediate)
- [ ] Business verification submitted
- [ ] Embedded Signup configured
- [ ] App Review submitted
- [ ] System-user long-lived token

---

## 2. Database schema (do this NOW — not blocked on Meta)

A new table to hold each org's WhatsApp connection. One row per connected
number; an org could connect more than one.

```sql
create table if not exists public.whatsapp_connections (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.organizations(id) on delete cascade,
  waba_id            text not null,          -- WhatsApp Business Account id
  phone_number_id    text not null unique,   -- the routing key: Meta's id for the number
  display_phone      text,                   -- "+91 73583..." for display
  verified_name      text,                   -- business display name on WA
  access_token       text not null,          -- token to send messages for this number
  token_type         text default 'system_user',
  status             text not null default 'active',  -- active | revoked | error
  connected_by       uuid references auth.users(id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists idx_wa_conn_phone on public.whatsapp_connections (phone_number_id);
create index if not exists idx_wa_conn_org   on public.whatsapp_connections (org_id, status);

alter table public.whatsapp_connections enable row level security;
drop policy if exists wa_conn_all on public.whatsapp_connections;
create policy wa_conn_all on public.whatsapp_connections for all using (true) with check (true);
```

**The routing key is `phone_number_id`** — Meta's webhook tells you which
number received the message, and you map that to an org.

---

## 3. Cloud API webhook adapter (build NOW against the test number)

Meta's webhook format is different from OpenWA's. Add a route to the Service
Genie backend (or keep it in a standalone service — your call).

### 3.1 Webhook verification (GET)
Meta verifies your webhook URL with a challenge:

```js
// GET /api/whatsapp/cloud-webhook
router.get("/cloud-webhook", (req, res) => {
  const mode = req.query["hub.mode"]
  const token = req.query["hub.verify_token"]
  const challenge = req.query["hub.challenge"]
  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge)   // echo the challenge back
  }
  res.sendStatus(403)
})
```

### 3.2 Incoming message (POST)
Meta's payload shape (simplified):

```json
{
  "object": "whatsapp_business_account",
  "entry": [{
    "id": "<WABA_ID>",
    "changes": [{
      "value": {
        "messaging_product": "whatsapp",
        "metadata": {
          "display_phone_number": "15550001111",
          "phone_number_id": "<PHONE_NUMBER_ID>"   // ← routing key
        },
        "contacts": [{ "profile": { "name": "Kishan" }, "wa_id": "917358350698" }],
        "messages": [{
          "from": "917358350698",       // ← real phone, no @lid nonsense
          "id": "wamid.XXXX",
          "timestamp": "1781073794",
          "type": "text",
          "text": { "body": "hi customer support" }
        }]
      },
      "field": "messages"
    }]
  }]
}
```

Handler:

```js
router.post("/cloud-webhook", async (req, res) => {
  res.sendStatus(200)  // ack Meta immediately

  for (const entry of req.body.entry || []) {
    for (const change of entry.changes || []) {
      const v = change.value || {}
      const phoneNumberId = v.metadata?.phone_number_id
      for (const msg of v.messages || []) {
        if (msg.type !== "text") continue
        const from = msg.from                 // real phone
        const body = msg.text?.body || ""
        // 1. resolve org from phoneNumberId
        const conn = await getConnByPhoneNumberId(phoneNumberId)
        if (!conn) continue                   // unknown number
        // 2. run the SAME chatbot state machine you already built,
        //    scoped to conn.org_id
        await handleMessage({ orgId: conn.org_id, from, body, conn })
      }
    }
  }
})
```

**Key wins over OpenWA:**
- `msg.from` is the real phone — no `@lid` resolution needed.
- `phone_number_id` tells you exactly which customer's number it is → clean
  multi-tenant routing.

### 3.3 Sending a reply
Replace the OpenWA send-text call with Meta's Graph API:

```js
async function sendWhatsApp(conn, toPhone, text) {
  await fetch(`https://graph.facebook.com/v21.0/${conn.phone_number_id}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${conn.access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: toPhone,
      type: "text",
      text: { body: text },
    }),
  })
}
```

**Important Cloud API rule:** you can only send free-form messages within a
**24-hour customer service window** after the customer's last message. Outside
that, you must use pre-approved **message templates**. For a support-ticket
bot this is usually fine (you reply right after they message), but if you ever
want to notify them later ("your ticket is resolved"), that needs a template.

---

## 4. Embedded Signup UI (needs your Meta App id — build after 1.2)

The "Connect WhatsApp" button in the Service Genie frontend. Uses the Facebook
JS SDK.

```html
<!-- load once -->
<script async src="https://connect.facebook.net/en_US/sdk.js"></script>
<script>
  window.fbAsyncInit = function () {
    FB.init({ appId: "<YOUR_META_APP_ID>", autoLogAppEvents: true, xfbml: true, version: "v21.0" })
  }

  function connectWhatsApp() {
    FB.login(function (response) {
      if (response.authResponse) {
        const code = response.authResponse.code   // exchange server-side
        // POST { code } to your backend → exchange for the customer's
        // WABA id, phone_number_id, and a token → store in whatsapp_connections
        fetch("/api/whatsapp/connect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code }),
        })
      }
    }, {
      config_id: "<YOUR_EMBEDDED_SIGNUP_CONFIG_ID>",
      response_type: "code",
      override_default_response_type: true,
      extras: { setup: {} },
    })
  }
</script>

<button onclick="connectWhatsApp()">Connect WhatsApp</button>
```

Backend `/api/whatsapp/connect`:
1. Exchange the `code` for an access token (Graph API token exchange).
2. Call Graph API to list the customer's WABAs + phone numbers.
3. Subscribe your app to that WABA's webhooks.
4. Store `{ org_id, waba_id, phone_number_id, access_token }` in
   `whatsapp_connections`.

---

## 5. Reusing what you already built

The chatbot brain in `openwa-gateway/chatbot/server.js` is the part worth
keeping. Refactor `handleMessage(...)` to take an `orgId` (and the connection)
as input instead of looking up "the one connected org". Then:

| Piece | OpenWA version | Cloud API version |
|---|---|---|
| Receive message | OpenWA webhook `data.from` (`@lid`) | Meta webhook `messages[].from` (real phone) |
| Identify org | single org (or sender lookup) | `phone_number_id` → `whatsapp_connections` |
| State machine | unchanged | unchanged |
| OpenAI relevance | unchanged | unchanged |
| Org selection step | **may not be needed** | the number already IS the org — skip "choose org" |
| Jira ticket creation | unchanged | unchanged |
| Send reply | OpenWA `/messages/send-text` | Graph API `/{phone_number_id}/messages` |

**Notice:** in the per-customer model, the "choose your organisation" step
goes away — the number the customer texted already identifies the org. The bot
goes straight to "describe your issue."

---

## 6. Environment variables (Cloud API)

```
# Meta app
WHATSAPP_APP_ID=...
WHATSAPP_APP_SECRET=...
WHATSAPP_VERIFY_TOKEN=<random string you choose; must match webhook config>
WHATSAPP_SYSTEM_USER_TOKEN=<long-lived token from 1.6>
WHATSAPP_GRAPH_VERSION=v21.0
```

---

## 7. Realistic timeline

| Week | What | Blocked on Meta? |
|---|---|---|
| Now | Schema + webhook adapter + reuse chatbot, test on Meta **test number** | No |
| Now | Submit business verification + create app | (starts the Meta clock) |
| ~1 | Embedded Signup config + Connect-WhatsApp UI, test with your own number | Partially |
| 1–2 | Business verification approved | Yes |
| 2–4 | App Review approved → real customers can connect | Yes |

You can have a **working demo on Meta's test number within a day or two** of
creating the app. Real-customer self-serve onboarding is the part that waits on
Meta's review.

---

## 8. Cost (Cloud API pricing, India)

- **Free tier:** 1,000 service conversations/month per number.
- Beyond that: priced per 24-hour conversation, ~₹0.30–0.80 depending on
  category (service/utility/marketing). Support tickets are "service"
  conversations — the cheapest, and the first 1,000/mo are free.
- **No hosting cost** for the gateway (Meta hosts it) — you only pay for your
  own backend (which you're already running).

This is dramatically cheaper than it looks for a support use case, and removes
the OpenWA Lightsail/EC2 cost entirely.

---

## 9. What to do first (concrete)

1. **Create the Meta App** (15 min) → get the test number + app id/secret.
2. **Run the schema migration** (section 2) in Supabase.
3. **Build the webhook adapter** (section 3) and point Meta's test number's
   webhook at it (via ngrok for local, or your deployed backend).
4. **Send a message to the test number** → confirm a ticket is created.
5. In parallel: **submit business verification** so the Meta clock starts.

Once the test-number flow works end-to-end, the remaining work is the Embedded
Signup UI and waiting on Meta's review — neither blocks proving the core.
