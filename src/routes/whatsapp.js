// WhatsApp connect flow: create an OpenWA session for the user, attach a
// webhook back to this portal, serve the QR, report status.
const express = require("express")
const { one, query } = require("../lib/db")
const openwa = require("../lib/openwa")
const { requireAuth } = require("./auth")

const router = express.Router()

// The URL OpenWA should POST messages to. The shared secret is embedded in the
// path so the webhook endpoint authenticates the caller (see webhook.js).
// PORTAL_WEBHOOK_BASE is the base (host:port/whatsapp/webhook); the secret is
// appended. From inside the OpenWA container the portal is reachable at
// host.docker.internal (local) or by service name (docker-compose).
function webhookUrl() {
  const base = (process.env.PORTAL_WEBHOOK_BASE ||
    process.env.PORTAL_WEBHOOK_URL ||
    "http://host.docker.internal:4200/whatsapp/webhook").replace(/\/+$/, "")
  const secret = process.env.WEBHOOK_SECRET || ""
  return secret ? `${base}/${secret}` : base
}

// POST /whatsapp/connect — create (or reuse) a session for this user + start it.
router.post("/connect", requireAuth, async (req, res) => {
  try {
    let sess = await one("select * from wa_sessions where user_id=$1", [req.userId])

    // Create an OpenWA session if we don't have one yet.
    if (!sess || !sess.openwa_session_id) {
      const created = await openwa.createSession(`u-${req.userId.slice(0, 8)}-${Date.now().toString(36)}`)
      const wh = await openwa.attachWebhook(created.id, webhookUrl())
      if (sess) {
        await query(
          "update wa_sessions set openwa_session_id=$1, webhook_id=$2, status='created', updated_at=now() where user_id=$3",
          [created.id, wh.id, req.userId],
        )
      } else {
        await query(
          "insert into wa_sessions (user_id, openwa_session_id, webhook_id, status) values ($1,$2,$3,'created')",
          [req.userId, created.id, wh.id],
        )
      }
      sess = await one("select * from wa_sessions where user_id=$1", [req.userId])
    }

    // Start it (generates a QR).
    await openwa.startSession(sess.openwa_session_id)
    res.json({ ok: true, session_id: sess.openwa_session_id })
  } catch (e) {
    console.error("[whatsapp/connect]", e.message, e.detail || "")
    res.status(502).json({ error: "connect_failed", detail: e.message })
  }
})

// GET /whatsapp/qr — current QR (base64 data URL) + status.
router.get("/qr", requireAuth, async (req, res) => {
  try {
    const sess = await one("select openwa_session_id from wa_sessions where user_id=$1", [req.userId])
    if (!sess?.openwa_session_id) return res.json({ ok: true, status: "none" })

    const s = await openwa.getSession(sess.openwa_session_id)
    const status = s.status
    // keep our copy of status fresh
    await query("update wa_sessions set status=$1, phone=$2, push_name=$3, updated_at=now() where user_id=$4",
      [status, s.phone || null, s.pushName || null, req.userId])

    let qrCode = null
    if (status === "qr_ready") {
      try { qrCode = (await openwa.getQr(sess.openwa_session_id)).qrCode } catch { /* not ready */ }
    }
    res.json({ ok: true, status, phone: s.phone || null, push_name: s.pushName || null, qrCode })
  } catch (e) {
    res.status(502).json({ error: "qr_failed", detail: e.message })
  }
})

// GET /whatsapp/status — quick status for the dashboard.
router.get("/status", requireAuth, async (req, res) => {
  const sess = await one("select openwa_session_id, phone, push_name, status from wa_sessions where user_id=$1", [req.userId])
  if (!sess?.openwa_session_id) return res.json({ ok: true, connected: false, status: "none" })
  try {
    const s = await openwa.getSession(sess.openwa_session_id)
    await query("update wa_sessions set status=$1, phone=$2, push_name=$3, updated_at=now() where user_id=$4",
      [s.status, s.phone || null, s.pushName || null, req.userId])
    res.json({ ok: true, connected: s.status === "ready", status: s.status, phone: s.phone || null, push_name: s.pushName || null })
  } catch {
    res.json({ ok: true, connected: false, status: sess.status, phone: sess.phone })
  }
})

// POST /whatsapp/disconnect — stop the session (keeps it, so Reconnect reuses it).
router.post("/disconnect", requireAuth, async (req, res) => {
  const sess = await one("select openwa_session_id from wa_sessions where user_id=$1", [req.userId])
  if (sess?.openwa_session_id) {
    try { await openwa.stopSession(sess.openwa_session_id) } catch { /* ignore */ }
  }
  res.json({ ok: true })
})

// POST /whatsapp/reset — fully remove the session so a NEW number can be linked.
// Deletes the OpenWA session (unlinks the device) and clears our DB row; the
// next Connect creates a fresh session + QR.
router.post("/reset", requireAuth, async (req, res) => {
  const sess = await one("select openwa_session_id from wa_sessions where user_id=$1", [req.userId])
  if (sess?.openwa_session_id) {
    try { await openwa.stopSession(sess.openwa_session_id) } catch { /* ignore */ }
    try { await openwa.deleteSession(sess.openwa_session_id) } catch { /* ignore */ }
  }
  await query("delete from wa_sessions where user_id=$1", [req.userId])
  res.json({ ok: true })
})

// ── Meta Cloud API connect ───────────────────────────────────────────────────
// POST /whatsapp/cloud/link — link this user to a Cloud API number.
//
// Two modes:
//   1. Dev/single-number: body empty → link the env test number
//      (META_PHONE_NUMBER_ID + META_WABA_ID + META_ACCESS_TOKEN).
//   2. Embedded Signup (later): body carries { phone_number_id, waba_id,
//      access_token } captured from the Facebook popup. We store them and
//      subscribe our app's webhook to the tenant's WABA.
const cloud = require("../lib/whatsapp-cloud")

router.post("/cloud/link", requireAuth, async (req, res) => {
  try {
    const phoneNumberId = (req.body && req.body.phone_number_id) || process.env.META_PHONE_NUMBER_ID
    const wabaId = (req.body && req.body.waba_id) || process.env.META_WABA_ID
    const accessToken = (req.body && req.body.access_token) || process.env.META_ACCESS_TOKEN

    if (!phoneNumberId || !accessToken) {
      return res.status(400).json({ error: "missing_phone_number_id_or_token" })
    }

    // Upsert the session row for this user with the Cloud credentials.
    await query(
      `insert into wa_sessions (user_id, phone_number_id, waba_id, access_token, provider, status)
       values ($1,$2,$3,$4,'cloud','ready')
       on conflict (user_id) do update set
         phone_number_id = excluded.phone_number_id,
         waba_id         = excluded.waba_id,
         access_token    = excluded.access_token,
         provider        = 'cloud',
         status          = 'ready',
         updated_at      = now()`,
      [req.userId, phoneNumberId, wabaId || null, accessToken],
    )

    // Subscribe our app to this WABA so inbound messages reach our webhook.
    // (For the shared dev test number this is a no-op / already subscribed.)
    let subscribed = false
    if (wabaId) {
      try { await cloud.subscribeWaba(wabaId, accessToken); subscribed = true }
      catch (e) { console.warn("[cloud/link] subscribeWaba failed:", e.message) }
    }

    res.json({ ok: true, phone_number_id: phoneNumberId, waba_id: wabaId || null, subscribed })
  } catch (e) {
    console.error("[cloud/link] failed:", e.message)
    res.status(500).json({ error: "link_failed", detail: e.message })
  }
})

// GET /whatsapp/cloud/status — is this user linked to a Cloud number?
router.get("/cloud/status", requireAuth, async (req, res) => {
  const s = await one(
    "select phone_number_id, waba_id, verified_name, phone, status, provider from wa_sessions where user_id=$1",
    [req.userId],
  )
  res.json({ ok: true, linked: !!(s && s.phone_number_id), session: s || null })
})

module.exports = { whatsappRouter: router }
