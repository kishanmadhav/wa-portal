// Meta WhatsApp Cloud API webhook.
//
// Two responsibilities:
//   GET  /whatsapp/cloud/webhook  — Meta's verification handshake (hub.challenge)
//   POST /whatsapp/cloud/webhook  — inbound messages + status callbacks
//
// Security: POST bodies are signed by Meta with X-Hub-Signature-256 (HMAC-SHA256
// of the raw body, keyed on the App Secret). We verify that before trusting
// anything. This replaces OpenWA's shared-secret-in-the-URL scheme.
//
// We normalise Meta's payload into the SAME event object the legacy handler
// consumes (see processInbound in webhook.js) so the ticket/operator/reminder
// business logic is reused verbatim.

const express = require("express")
const crypto = require("crypto")
const { one } = require("../lib/db")

const router = express.Router()

const VERIFY_TOKEN = process.env.META_WEBHOOK_VERIFY_TOKEN || ""
const APP_SECRET = process.env.META_APP_SECRET || ""

// The shared message processor lives in webhook.js. We import it lazily to avoid
// a circular require at module load.
function processInbound(evt) {
  return require("./webhook").processInbound(evt)
}

// ── GET: verification handshake ──────────────────────────────────────────────
// Meta calls this once when you save the webhook URL in the App dashboard.
router.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"]
  const token = req.query["hub.verify_token"]
  const challenge = req.query["hub.challenge"]
  if (mode === "subscribe" && VERIFY_TOKEN && token === VERIFY_TOKEN) {
    console.log("[cloud-webhook] verified")
    return res.status(200).send(challenge)
  }
  console.warn("[cloud-webhook] verification failed")
  return res.sendStatus(403)
})

// Verify X-Hub-Signature-256 against the raw body using the app secret.
function validSignature(req) {
  if (!APP_SECRET) {
    // No app secret configured → we cannot verify the signature. We allow the
    // request through but log loudly, so you can validate the webhook and test
    // BEFORE pasting META_APP_SECRET. Set META_APP_SECRET as soon as possible:
    // without it, anyone who learns the URL could POST forged messages.
    console.warn("[cloud-webhook] META_APP_SECRET not set — accepting UNVERIFIED webhook (set it ASAP)")
    return true
  }
  const sig = req.get("x-hub-signature-256") || ""
  if (!sig.startsWith("sha256=")) return false
  const expected = "sha256=" + crypto
    .createHmac("sha256", APP_SECRET)
    .update(req.rawBody || Buffer.from(""))
    .digest("hex")
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
  } catch {
    return false
  }
}

// ── POST: inbound messages / statuses ────────────────────────────────────────
router.post("/webhook", async (req, res) => {
  // Always 200 fast so Meta doesn't retry; process async.
  res.sendStatus(200)

  if (!validSignature(req)) {
    console.warn("[cloud-webhook] bad signature — dropping")
    return
  }

  try {
    const body = req.body || {}
    if (body.object !== "whatsapp_business_account") return

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== "messages") continue
        const value = change.value || {}
        const metadata = value.metadata || {}
        const phoneNumberId = metadata.phone_number_id // identifies the tenant's number
        const contacts = value.contacts || []

        // Statuses (sent/delivered/read/failed) — log, don't process as messages.
        if (Array.isArray(value.statuses) && value.statuses.length) {
          for (const st of value.statuses) {
            if (st.status === "failed") {
              console.warn(`[cloud-webhook] delivery failed to ${st.recipient_id}:`,
                JSON.stringify(st.errors || []))
            }
          }
          continue
        }

        for (const msg of value.messages || []) {
          // Text, plus taps on interactive lists/buttons (used for the space
          // picker). A tap arrives as msg.interactive.{list_reply|button_reply}
          // with the row `id` we sent; surface it both as `body` (so the shared
          // processor can treat it like typed input) and as `interactiveId`.
          let text = ""
          let interactiveId = null
          if (msg.type === "text") {
            text = (msg.text && msg.text.body ? msg.text.body : "").trim()
          } else if (msg.type === "interactive" && msg.interactive) {
            const r = msg.interactive.list_reply || msg.interactive.button_reply
            if (r && r.id) { interactiveId = String(r.id); text = interactiveId }
          }
          if (!text) {
            console.log(`[cloud-webhook] ignoring type=${msg.type}`)
            continue
          }
          const fromPhone = msg.from // E.164 digits, no + — exactly what we want
          if (!phoneNumberId || !fromPhone || !text) continue

          // Which tenant owns this number? Look up their send credentials.
          const sess = await one(
            "select user_id, access_token, phone_number_id from wa_sessions where phone_number_id=$1",
            [phoneNumberId],
          )
          if (!sess) {
            console.warn("[cloud-webhook] no tenant for phone_number_id", phoneNumberId)
            continue
          }

          // Build the normalised event the shared processor understands.
          // `session` carries the send context so replies go back out the same
          // number with the tenant's token.
          const evt = {
            provider: "cloud",
            session: {
              phoneNumberId: sess.phone_number_id,
              accessToken: sess.access_token,
            },
            userId: sess.user_id,
            fromPhone,               // already a bare phone number
            chatId: fromPhone,       // Cloud has no @c.us/@lid; chatId === phone
            body: text,
            interactiveId,
            messageId: msg.id,
            pushName: (contacts[0] && contacts[0].profile && contacts[0].profile.name) || null,
          }

          processInbound(evt).catch((e) =>
            console.error("[cloud-webhook] processInbound error:", e.message))
        }
      }
    }
  } catch (e) {
    console.error("[cloud-webhook] handler error:", e.message)
  }
})

module.exports = { cloudWebhookRouter: router }
