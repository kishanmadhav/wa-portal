// Thin client for the Meta WhatsApp Cloud API (Graph API).
//
// Replaces the self-hosted OpenWA gateway. Key differences from OpenWA:
//   - No sessions/QR: a number is identified by its `phone_number_id`.
//   - Auth is a bearer access token (per-tenant for Embedded Signup, or a single
//     dev token from env for the test number).
//   - Sending outside the 24h customer-service window requires a template.
//
// The public surface mirrors openwa.js where it can (sendText) so the rest of
// the app doesn't care which provider is active.

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v21.0"
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`

const DEFAULT_TOKEN = process.env.META_ACCESS_TOKEN || ""
const DEFAULT_PHONE_ID = process.env.META_PHONE_NUMBER_ID || ""
const TEMPLATE_LANG = process.env.META_TEMPLATE_LANG || "en_US"

// A tenant's send context. For the single-number dev setup we fall back to the
// env token + phone id; for Embedded Signup these come from the DB per user.
function ctx({ phoneNumberId, accessToken } = {}) {
  return {
    phoneNumberId: phoneNumberId || DEFAULT_PHONE_ID,
    accessToken: accessToken || DEFAULT_TOKEN,
  }
}

async function graph(method, path, { token, body } = {}) {
  const res = await fetch(`${GRAPH_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  if (!res.ok) {
    const err = new Error(`meta_${res.status}`)
    err.status = res.status
    err.detail = json
    // Meta wraps errors as { error: { message, code, error_subcode, ... } }
    err.metaError = json && json.error ? json.error : null
    throw err
  }
  return json
}

// Normalise a recipient to E.164 digits (Meta wants no +, no @c.us, no spaces).
function toWaId(recipient) {
  return String(recipient || "").replace(/[^\d]/g, "")
}

// ── Send a free-form text message ────────────────────────────────────────────
// Only delivers if the recipient is inside the 24h customer-service window
// (i.e. they messaged this number in the last 24h). Outside it, Meta returns a
// 131047-ish error — callers that need to reach a cold contact should use
// sendTemplate instead.
//
// Signature mirrors openwa.sendText(sessionId, chatId, text) BUT here the first
// arg is the tenant's send context (phoneNumberId + token). The webhook builds
// this context from the DB, so call sites pass it through unchanged conceptually.
async function sendText(sendCtx, recipient, text) {
  const c = ctx(sendCtx)
  if (!c.accessToken) throw new Error("meta_no_access_token")
  if (!c.phoneNumberId) throw new Error("meta_no_phone_number_id")
  return graph("POST", `/${c.phoneNumberId}/messages`, {
    token: c.accessToken,
    body: {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: toWaId(recipient),
      type: "text",
      text: { preview_url: true, body: String(text).slice(0, 4096) },
    },
  })
}


// ── Send an interactive list (tap-to-choose menu) ────────────────────────────
// Meta renders this as a button that opens a native picker. Used for "choose a
// space" so the operator taps rather than types a project key.
//
// Constraints enforced by Meta, applied here so a bad call fails loudly in our
// code rather than as an opaque meta_400: max 10 rows in total, row title
// <= 24 chars, row id <= 200 chars, body <= 1024 chars, button label <= 20.
//
// `rows` = [{ id, title, description? }]. The tapped row's `id` comes back in
// the webhook as interactive.list_reply.id.
async function sendList(sendCtx, recipient, { header, body, button, rows, footer } = {}) {
  const c = ctx(sendCtx)
  if (!c.accessToken) throw new Error("meta_no_access_token")
  if (!c.phoneNumberId) throw new Error("meta_no_phone_number_id")
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("list_needs_rows")
  if (rows.length > 10) throw new Error("list_max_10_rows")

  const interactive = {
    type: "list",
    body: { text: String(body || "Choose one").slice(0, 1024) },
    action: {
      button: String(button || "Choose").slice(0, 20),
      sections: [{
        title: String(header || "Options").slice(0, 24),
        rows: rows.map((r) => ({
          id: String(r.id).slice(0, 200),
          title: String(r.title).slice(0, 24),
          ...(r.description ? { description: String(r.description).slice(0, 72) } : {}),
        })),
      }],
    },
  }
  if (header) interactive.header = { type: "text", text: String(header).slice(0, 60) }
  if (footer) interactive.footer = { text: String(footer).slice(0, 60) }

  return graph("POST", `/${c.phoneNumberId}/messages`, {
    token: c.accessToken,
    body: {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: toWaId(recipient),
      type: "interactive",
      interactive,
    },
  })
}

// ── Send a pre-approved template ─────────────────────────────────────────────
// Works anytime (no 24h window). `components` is the Meta template component
// array for variable substitution; omit for a static template like hello_world.
async function sendTemplate(sendCtx, recipient, templateName, { lang, components } = {}) {
  const c = ctx(sendCtx)
  if (!c.accessToken) throw new Error("meta_no_access_token")
  if (!c.phoneNumberId) throw new Error("meta_no_phone_number_id")
  const template = { name: templateName, language: { code: lang || TEMPLATE_LANG } }
  if (Array.isArray(components) && components.length) template.components = components
  return graph("POST", `/${c.phoneNumberId}/messages`, {
    token: c.accessToken,
    body: {
      messaging_product: "whatsapp",
      to: toWaId(recipient),
      type: "template",
      template,
    },
  })
}

// ── Mark an inbound message as read (blue ticks) ─────────────────────────────
async function markRead(sendCtx, messageId) {
  const c = ctx(sendCtx)
  if (!c.accessToken || !c.phoneNumberId || !messageId) return null
  try {
    return await graph("POST", `/${c.phoneNumberId}/messages`, {
      token: c.accessToken,
      body: { messaging_product: "whatsapp", status: "read", message_id: messageId },
    })
  } catch {
    return null // non-fatal
  }
}

// ── Subscribe our app's webhook to a WABA (Embedded Signup step) ─────────────
// After a tenant onboards their WABA, we must subscribe our app to it so their
// messages reach our webhook.
async function subscribeWaba(wabaId, token) {
  return graph("POST", `/${wabaId}/subscribed_apps`, { token: token || DEFAULT_TOKEN })
}

// ── Register a phone number for Cloud API (Embedded Signup step) ─────────────
// Sets the two-step PIN and registers the number so it can send/receive.
async function registerNumber(phoneNumberId, token, pin) {
  return graph("POST", `/${phoneNumberId}/register`, {
    token: token || DEFAULT_TOKEN,
    body: { messaging_product: "whatsapp", pin: String(pin) },
  })
}

module.exports = {
  GRAPH_BASE,
  toWaId,
  ctx,
  sendText,
  sendList,
  sendTemplate,
  markRead,
  subscribeWaba,
  registerNumber,
}
