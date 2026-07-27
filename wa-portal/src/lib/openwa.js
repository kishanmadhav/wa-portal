// Thin client for the OpenWA gateway API.
const BASE = (process.env.OPENWA_URL || "http://localhost:2785").replace(/\/+$/, "")
const KEY = process.env.OPENWA_API_KEY || "dev-admin-key"

function headers(extra) {
  return { "X-API-Key": KEY, ...(extra || {}) }
}

async function req(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: headers(body ? { "Content-Type": "application/json" } : {}),
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  if (!res.ok) {
    const err = new Error(`openwa_${res.status}`)
    err.status = res.status
    err.detail = json
    throw err
  }
  return json
}

// Sessions
const createSession = (name) => req("POST", "/api/sessions", { name })
const getSession = (id) => req("GET", `/api/sessions/${id}`)
const startSession = (id) => req("POST", `/api/sessions/${id}/start`)
const stopSession = (id) => req("POST", `/api/sessions/${id}/stop`)
const deleteSession = (id) => req("DELETE", `/api/sessions/${id}`)
const getQr = (id) => req("GET", `/api/sessions/${id}/qr`)

// Webhooks
const attachWebhook = (id, url) =>
  req("POST", `/api/sessions/${id}/webhooks`, { url, events: ["message.received"] })

// Contacts — resolve a @lid privacy address to a real phone.
async function resolveContact(sessionId, chatId) {
  try {
    return await req("GET", `/api/sessions/${sessionId}/contacts/${encodeURIComponent(chatId)}`)
  } catch {
    return null
  }
}

// Send a text reply.
const sendText = (sessionId, chatId, text) =>
  req("POST", `/api/sessions/${sessionId}/messages/send-text`, { chatId, text })

module.exports = {
  createSession, getSession, startSession, stopSession, deleteSession, getQr,
  attachWebhook, resolveContact, sendText,
}
