// Provider router for WhatsApp send/receive.
//
// The rest of the app calls wa.sendText(session, recipient, text) without caring
// whether messages go through the legacy OpenWA gateway or the Meta Cloud API.
// The provider is chosen by WHATSAPP_PROVIDER ("cloud" | "openwa").
//
// `session` is a descriptor object the webhook builds per inbound message:
//   OpenWA:  { openwaSessionId }
//   Cloud:   { phoneNumberId, accessToken }
// Legacy call sites that passed a bare openwa session-id string still work — we
// coerce a string into { openwaSessionId }.

const openwa = require("./openwa")
const cloud = require("./whatsapp-cloud")

const PROVIDER = (process.env.WHATSAPP_PROVIDER || "openwa").toLowerCase()

function isCloud() {
  return PROVIDER === "cloud"
}

// Accept either a descriptor object or a legacy bare session-id string.
function normSession(session) {
  if (session && typeof session === "object") return session
  return { openwaSessionId: session }
}

// Send a free-form text reply. Recipient is a phone (Cloud) or chatId (OpenWA).
async function sendText(session, recipient, text) {
  const s = normSession(session)
  if (isCloud()) {
    return cloud.sendText(
      { phoneNumberId: s.phoneNumberId, accessToken: s.accessToken },
      recipient,
      text,
    )
  }
  return openwa.sendText(s.openwaSessionId, recipient, text)
}

// Send a pre-approved template (Cloud only; used outside the 24h window).
// On OpenWA there are no templates, so we fall back to a plain text send.
async function sendTemplate(session, recipient, templateName, opts) {
  const s = normSession(session)
  if (isCloud()) {
    return cloud.sendTemplate(
      { phoneNumberId: s.phoneNumberId, accessToken: s.accessToken },
      recipient,
      templateName,
      opts,
    )
  }
  // OpenWA fallback: send the opts.fallbackText if provided, else nothing useful.
  if (opts && opts.fallbackText) return openwa.sendText(s.openwaSessionId, recipient, opts.fallbackText)
  return null
}

module.exports = { PROVIDER, isCloud, sendText, sendTemplate }
