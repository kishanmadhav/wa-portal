// Inbound WhatsApp webhook. OpenWA posts every message here. We route by the
// OpenWA session id -> the owning user, run a light support flow, and create
// tickets in THAT user's Jira.
//
// Flow per sender (no org-selection — the number already identifies the tenant):
//   any message -> "Hi! Please describe your issue..." (greet once)
//   relevant issue -> create ticket -> "ticket created, thank you"
//   irrelevant     -> re-prompt
const express = require("express")
const OpenAI = require("openai").default
const rateLimit = require("express-rate-limit")
const { one, all, query } = require("../lib/db")
const openwa = require("../lib/openwa")
const wa = require("../lib/wa")           // provider router (openwa | cloud)
const jira = require("../lib/jira")

const router = express.Router()
router.use(express.json({ limit: "100mb" })) // WA payloads can be large

// ── Immediate Service Genie sync trigger ─────────────────────────────────────
// When a ticket is created here, ping Service Genie's cron endpoint so the new
// ticket is fetched + classified + triaged within seconds (instead of waiting
// for the 5-min worker). Fire-and-forget: never blocks the WhatsApp reply, and
// failures are harmless because the 5-min cron is the backstop.
//
// A short delay lets Jira's search index catch the brand-new ticket before the
// sync's JQL query runs (otherwise the immediate sync can miss it).
const SG_SYNC_URL = process.env.SERVICE_GENIE_SYNC_URL || ""
const SG_CRON_SECRET = process.env.SERVICE_GENIE_CRON_SECRET || ""
const SG_SYNC_DELAY_MS = Number(process.env.SERVICE_GENIE_SYNC_DELAY_MS || 4000)

function triggerServiceGenieSync(ticketKey) {
  if (!SG_SYNC_URL || !SG_CRON_SECRET) return // not configured — rely on cron
  setTimeout(() => {
    fetch(SG_SYNC_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${SG_CRON_SECRET}` },
    })
      .then((r) => console.log(`[webhook] SG sync triggered for ${ticketKey}: HTTP ${r.status}`))
      .catch((e) => console.error(`[webhook] SG sync trigger failed for ${ticketKey}:`, e.message))
  }, SG_SYNC_DELAY_MS).unref?.()
}

// Webhook rate-limit: caps OpenAI/Jira cost + ticket spam even if the secret
// leaks. Generous because legit traffic is a single OpenWA instance bursting.
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120, // 2/sec sustained — far above real WhatsApp throughput
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "rate_limited" },
})

// Shared secret that authenticates the webhook. OpenWA is configured to POST to
// /whatsapp/webhook/<WEBHOOK_SECRET>. Anyone hitting the endpoint without the
// exact secret is rejected — without this, the endpoint is open to the internet
// and anyone could forge messages and create tickets in a customer's Jira.
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || ""

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || ""
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini"
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null
const TRIGGER_PHRASE = (process.env.TRIGGER_PHRASE || "hi genie").toLowerCase().trim()
const GREETING = process.env.GREETING ||
  "Hi! You've reached support. Please describe your issue and we'll create a ticket for you."
const ASSIST_PROMPT = process.env.ASSIST_PROMPT ||
  "Do you need any further assistance? You can reply with details like \"assign to: <name or email>, priority: <high/medium/low>\", or say \"no further assistance\" to finish."

// ── OpenAI relevance judge ───────────────────────────────────────────────────
async function isRelevantIssue(text) {
  if (!openai) return true
  try {
    const res = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [{
        role: "user",
        content: `A user is messaging IT/customer support over WhatsApp. Decide if their message describes an actual problem, request, or question worth a support ticket (even loosely). Greetings, gibberish, single words like "ok"/"hi"/"thanks" are NOT relevant.

Message: "${String(text).slice(0, 800)}"

Reply ONLY with JSON: { "relevant": true|false }`,
      }],
      temperature: 0,
      max_tokens: 20,
      response_format: { type: "json_object" },
    })
    return JSON.parse(res.choices[0]?.message?.content || "{}").relevant === true
  } catch (e) {
    console.error("[webhook] relevance check failed, defaulting true:", e.message)
    return true
  }
}

// Classify a reply to the "need further assistance?" question.
// Returns { intent, assignee, priority }:
//   intent = "provide_details" | "no_further" | "irrelevant"
async function parseAssistReply(text) {
  const t = String(text || "").trim()
  // Fast non-LLM path for the obvious cases.
  if (/\b(no|nope|nothing|that'?s all|i'?m good|all good|no further|nah)\b/i.test(t) && t.length < 40) {
    return { intent: "no_further", assignee: null, priority: null }
  }
  if (!openai) {
    // Heuristic fallback: pull "assign to:" and "priority:" if present.
    const a = t.match(/assign(?:ed)?\s*to\s*[:\-]?\s*([^\n,;]+)/i)
    const p = t.match(/priority\s*[:\-]?\s*([a-z0-9 ]+)/i)
    if (a || p) return { intent: "provide_details", assignee: a?.[1]?.trim() || null, priority: p?.[1]?.trim() || null }
    return { intent: "irrelevant", assignee: null, priority: null }
  }
  try {
    const res = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [{
        role: "user",
        content: `A support bot just created a ticket and asked the customer if they need further assistance. Classify the customer's reply.

Reply: "${t.slice(0, 600)}"

Decide the intent:
- "provide_details": they want the ticket assigned to someone and/or given a priority. Extract:
   - assignee: a person's name or email (or null)
   - priority: a priority word like high/urgent/medium/low (or null)
- "no_further": they're done / don't need anything else.
- "irrelevant": chit-chat, gibberish, or unrelated.

Return ONLY JSON: { "intent": "...", "assignee": "<text or null>", "priority": "<word or null>" }`,
      }],
      temperature: 0,
      max_tokens: 80,
      response_format: { type: "json_object" },
    })
    const parsed = JSON.parse(res.choices[0]?.message?.content || "{}")
    const intent = ["provide_details", "no_further", "irrelevant"].includes(parsed.intent) ? parsed.intent : "irrelevant"
    const norm = (v) => (v && String(v).toLowerCase() !== "null" ? String(v).trim() : null)
    return { intent, assignee: norm(parsed.assignee), priority: norm(parsed.priority) }
  } catch (e) {
    console.error("[webhook] assist parse failed:", e.message)
    return { intent: "irrelevant", assignee: null, priority: null }
  }
}

// ── Verified-operator assistant ──────────────────────────────────────────────
// Operators (trusted phone numbers) chat with a Jira assistant over WhatsApp.
// It keeps a rolling conversation context per operator so follow-ups ("those
// tickets", "mark them resolved") resolve naturally, and can both QUERY and
// take WRITE actions (resolve / reopen / assign / set priority).

const { normPhone } = require("./operators")
const { resolveSpaceKeys } = require("../lib/roles")
const { notifyAssignment } = require("../lib/notify")

// Returns the operator record enriched with their space-scoped roles, so
// downstream handlers know not just THAT the sender is trusted but WHERE.
//
//   role     — strongest role held: operator | admin | super_admin
//   spaces   — project keys they may act in ([] when allSpaces is true)
//   allSpaces— true for a super admin
//
// wa_operators remains the "is this phone trusted at all" gate. A phone with
// no row there is an unknown sender regardless of wa_space_roles, so revoking
// from the operator list still locks someone out.

// Send the tap-to-choose space list. Falls back to a numbered text menu on
// providers without interactive messages (legacy OpenWA), where the operator
// then types the project key.
async function sendSpacePicker(session, chatId, spaces, sendText) {
  const rows = spaces.slice(0, 10).map((k) => ({ id: `space:${k}`, title: k, description: `Work in ${k}` }))
  if (wa.sendList) {
    try {
      await wa.sendList(session, chatId, {
        header: "Choose a space",
        body: "Which Jira project do you want to work in?",
        button: "Choose space",
        rows,
        footer: spaces.length > 10 ? `Showing 10 of ${spaces.length}` : undefined,
      })
      return
    } catch (e) {
      console.warn("[webhook] interactive list failed, falling back to text:", e.message)
    }
  }
  await sendText(
    "Which Jira space do you want to work in? Reply with the key:\n\n" +
    spaces.map((k) => `• *${k}*`).join("\n"),
  )
}

async function getOperator(userId, fromPhone) {
  const digits = normPhone(fromPhone)
  if (!digits) return null
  const op = await one(
    "select id, phone, label from wa_operators where user_id=$1 and phone=$2",
    [userId, digits],
  )
  if (!op) return null

  let roles = []
  try {
    roles = await all(
      "select role, space_key from wa_space_roles where user_id=$1 and phone=$2",
      [userId, digits],
    )
  } catch (e) {
    // The roles table may not exist yet (migration not applied). Fall back to
    // the pre-roles behaviour rather than locking every operator out.
    if (!/relation .* does not exist/i.test(e.message || "")) {
      console.error("[webhook] role lookup failed:", e.message)
    }
  }

  const allSpaces = roles.some((r) => r.role === "super_admin")
  const rank = { operator: 1, admin: 2, super_admin: 3 }
  const role = roles.length
    ? roles.reduce((b, r) => (rank[r.role] > rank[b] ? r.role : b), roles[0].role)
    : "operator"

  return {
    ...op,
    role,
    allSpaces,
    spaces: allSpaces ? [] : [...new Set(roles.map((r) => r.space_key).filter(Boolean))],
  }
}

// Per-operator conversation context (in-process, 15-min TTL).
//   { history: [{role, content}], lastKeys: ["HGD-1",...], lastFilter: {...}, at }
const operatorCtx = new Map()
const OP_CTX_TTL_MS = 15 * 60 * 1000
function getCtx(key) {
  const c = operatorCtx.get(key)
  if (c && Date.now() - c.at < OP_CTX_TTL_MS) return c
  const fresh = { history: [], lastKeys: [], lastFilter: null, at: Date.now() }
  operatorCtx.set(key, fresh)
  return fresh
}

// JQL builders.
function statusJql(word) {
  const w = String(word || "").toLowerCase()
  if (!w) return null
  if (/(^|\b)(open|to ?do|new|backlog)\b/.test(w)) return 'statusCategory = "To Do"'
  if (/(in ?progress|doing|active|wip)/.test(w)) return 'statusCategory = "In Progress"'
  if (/(done|closed|resolved|complete)/.test(w)) return "statusCategory = Done"
  return `status = "${w.replace(/"/g, "")}"`
}
function priorityJql(word) {
  const w = String(word || "").toLowerCase()
  if (!w) return null
  const map = { highest: "Highest", critical: "Highest", urgent: "Highest", high: "High",
    medium: "Medium", normal: "Medium", low: "Low", lowest: "Lowest", minor: "Low" }
  const name = map[w] || (w.charAt(0).toUpperCase() + w.slice(1))
  return `priority = "${name}"`
}
async function assigneeJql(userId, phrase) {
  const p = String(phrase || "").trim()
  if (!p) return null
  if (/^unassigned$/i.test(p)) return { clause: "assignee is EMPTY", resolvedName: "Unassigned" }
  const user = await jira.findUser(userId, p)
  if (!user) return { clause: null, resolvedName: null, notFound: p }
  return { clause: `assignee = "${user.accountId}"`, resolvedName: user.displayName }
}
function andClauses(...cs) { return cs.filter(Boolean).join(" AND ") || null }
async function buildFilter(userId, q) {
  const parts = [], desc = []
  if (q.status) { const c = statusJql(q.status); if (c) { parts.push(c); desc.push(q.status) } }
  if (q.priority) { const c = priorityJql(q.priority); if (c) { parts.push(c); desc.push(q.priority + " priority") } }
  if (q.assignee) {
    const a = await assigneeJql(userId, q.assignee)
    if (a?.notFound) return { error: `I couldn't find a Jira user matching "${a.notFound}".` }
    if (a?.clause) { parts.push(a.clause); desc.push(`assigned to ${a.resolvedName}`) }
  }
  return { filter: andClauses(...parts), descParts: desc }
}
// Reply formatting. WhatsApp supports *bold*, _italic_, and monospace only —
// no tables, no headings — so structure comes from consistent line shape:
// one ticket = key + title line, then an indented status line.
const PRIO_ICON = { highest: "🔴", high: "🟠", medium: "🟡", low: "🟢", lowest: "⚪" }
function prioIcon(p) { return PRIO_ICON[String(p || "").toLowerCase()] || "▫️" }

function fmtTicket(t) {
  return (
    `*${t.key}*  ${prioIcon(t.priority)} ${t.priority || "—"}\n` +
    `${t.summary}\n\n` +
    `Status:    ${t.status || "—"}\n` +
    `Assignee:  ${t.assignee || "Unassigned"}`
  )
}

function fmtTicketList(items, desc) {
  const head = `📋 *Tickets*${desc ? ` — ${desc}` : ""}  _(${items.length})_`
  const rows = items.map((t, i) =>
    `${i + 1}. *${t.key}* ${prioIcon(t.priority)}\n` +
    `    ${String(t.summary || "").slice(0, 60)}\n` +
    `    _${t.status} · ${t.assignee || "Unassigned"}_`,
  )
  return head + "\n\n" + rows.join("\n\n") + "\n\n_Reply with a key for details, or \"assign HGD-12 to <name>\"._"
}

// Current time formatted in IST, for the LLM to resolve relative times.
// IMPORTANT: spell the date out in words ("Wednesday, 8 July 2026") — a numeric
// "08/07/2026" is ambiguous (UK day/month vs US month/day) and the model read
// it as August 7, scheduling "today" reminders a month out.
function nowIstString() {
  return new Date().toLocaleString("en-GB", {
    timeZone: "Asia/Kolkata",
    weekday: "long", day: "numeric", month: "long", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false,
  })
}

// Ask the LLM to turn the latest message (with conversation context) into a
// fully-resolved action. Ticket references like "those"/"these 5" are resolved
// to explicit keys using ctx.lastKeys.
async function interpretOperator(body, ctx) {
  if (!openai) return { action: "unknown" }
  const sys = `You are a Jira assistant operating over WhatsApp for a support team. Convert the user's latest message into ONE structured action, using the conversation context to resolve references like "those tickets", "these 5", "it", "them".

Current date/time is ${nowIstString()} IST (Asia/Kolkata). Resolve all relative times ("by end of month", "tomorrow 5pm", "in 2 hours") against this. Assume IST unless another timezone is stated.

Context you have:
- Ticket keys from the most recent list/result: ${ctx.lastKeys.length ? ctx.lastKeys.join(", ") : "(none)"}
- The most recent query filter: ${ctx.lastFilter ? JSON.stringify(ctx.lastFilter) : "(none)"}

Actions:
- "count": how many tickets match. filters: {status, priority, assignee}
- "list": list tickets matching. filters: {status, priority, assignee}
- "detail": show one ticket. key = "<TICKET-KEY>"
- "recent": newest / recently updated tickets.
- "resolve": mark ticket(s) as done/resolved. keys = ["<KEY>", ...]  (resolve the referenced tickets)
- "reopen": reopen closed ticket(s). keys = ["<KEY>", ...]
- "assign": set assignee on ticket(s). keys = [...], assignee = "<name/email>"
- "set_priority": set priority on ticket(s). keys = [...], priority = "<level>"
- "set_status": move ticket(s) to ANY named workflow status ("move HGD-1 to in progress", "put those in review", "mark HGD-2 as blocked", "change status of HGD-3 to waiting for customer"). keys = [...], status = "<target status name>". Use "resolve"/"reopen" instead when they say resolve/close/done or reopen.
- "delete": PERMANENTLY delete ticket(s) ("delete HGD-3", "remove those tickets", "get rid of HGD-4 and HGD-5"). keys = [...].
- "comment": add a comment/note to ticket(s) ("comment on HGD-4: waiting for vendor", "add a note to those saying the parts arrived"). keys = [...], comment_text = "<the comment text, without the ticket key or the word comment>".
- "create": create a NEW ticket. Triggered by ANY phrasing that asks for a ticket: "create/raise/open/log/file a ticket", "new ticket", "report ...", "ticket for ...", "we need a ticket about ...". Extract: summary (concise title), optional priority, optional assignee. If the message ALSO states a deadline/due time for the work, set deadline_iso (see below).
- "remind": set reminder(s). Extract:
  - reminder_text: WHAT it's about — a short clean event/task phrase (e.g. "Team meeting", "Pay the AWS bill"), NOT the user's full sentence. Do NOT include times or the words "remind me" in it. PRESERVE any URLs/links verbatim in the JSON (put them in reminder_text).
  - event_time_iso: when the event/deadline ITSELF is (null if none stated).
  - remind_at_iso: ARRAY of datetimes to SEND reminders at. Rules:
    * "remind me to <task> by/at X" (no separate event time) → ["X"]
    * "I have a meet at Y, set a reminder at X" / "remind me at X for the Y meeting" → ["X","Y"] (remind BEFORE and AT the event)
    * multiple explicit times ("remind me at 6 and again at 7") → all of them
    * no time at all → []
  - audience: "all" if for the whole team / all operators / everyone ("remind all operators", "remind the team", "tell everyone", "set a reminder for all verified operators"); otherwise "me".
  Examples:
  * "remind me to pay the AWS bill by end of month" → reminder_text "Pay the AWS bill", remind_at_iso [last-day 23:59], audience "me"
  * "hey I have a meet at 7:30, set a reminder for the 7:30 pm meet at 6:30 pm" → reminder_text "Meeting", event_time_iso 19:30, remind_at_iso [18:30, 19:30], audience "me"
  * "set a reminder for all verified operators for a meet at 7:30 pm, link: <url>" → reminder_text "Meeting <url>", event_time_iso 19:30, remind_at_iso [19:30], audience "all"
- "agenda": they're ASKING ABOUT existing schedule items — what reminders/calls/meetings they already have coming up ("do I have any calls today", "what's on my schedule", "what reminders do I have", "any reminders coming up", "anything coming up", "my agenda", "what meetings today"). This is a QUESTION about existing items; it does NOT create anything. No extra fields needed.
  IMPORTANT: distinguish from "remind". "remind me to <do something> at <time>" CREATES a new reminder. A question like "any reminders coming up?" / "what reminders do I have?" with no task and no new time is "agenda", NOT "remind".
- "help": they're confused or asked generally what you can do.
- "capability": they ask whether you can do a SPECIFIC thing ("can you send emails?", "can you attach files?") OR request something OUTSIDE your abilities (sending emails, editing ticket descriptions, attachments, dashboards, calling people, non-Jira tasks). Set asked = "<short phrase of what they wanted>", e.g. "send emails".
- "unknown": unrelated chit-chat/gibberish.

Time fields (deadline_iso, event_time_iso, every entry of remind_at_iso):
- ABSOLUTE ISO-8601 datetimes WITH the +05:30 offset for IST (e.g. "2026-06-17T12:00:00+05:30"). Null/[] if no time is mentioned. Compute from the current time above. Bare times like "7:30" mean the NEXT upcoming 7:30 (assume pm for meeting-ish hours if am would be in the past).

Rules:
- "those/these/them/the N tickets/it" → use the context ticket keys. If a count like "these 5" is given but context has more/fewer, use the context keys you have.
- A filter mentioned now overrides; otherwise inherit the last filter for list/count follow-ups.
- For status/priority words map loosely (open, high, etc).
- "unassigned" is a valid assignee value.

Return ONLY JSON:
{ "action":"...", "key": null, "keys": [], "status": null, "priority": null, "assignee": null, "summary": null, "comment_text": null, "asked": null, "reminder_text": null, "deadline_iso": null, "event_time_iso": null, "remind_at_iso": [], "audience": "me" }`

  const messages = [
    { role: "system", content: sys },
    ...ctx.history.slice(-6), // last few turns for reference
    { role: "user", content: body.slice(0, 500) },
  ]
  try {
    const res = await openai.chat.completions.create({
      model: OPENAI_MODEL, messages, temperature: 0, max_tokens: 350,
      response_format: { type: "json_object" },
    })
    const p = JSON.parse(res.choices[0]?.message?.content || "{}")
    const norm = (v) => (v && String(v).toLowerCase() !== "null" ? String(v).trim() : null)
    const keys = Array.isArray(p.keys) ? p.keys.map((k) => String(k).toUpperCase()).filter((k) => /^[A-Z][A-Z0-9]+-\d+$/.test(k)) : []
    const valid = ["count", "list", "detail", "recent", "resolve", "reopen", "assign", "set_priority", "set_status", "delete", "comment", "create", "remind", "agenda", "help", "capability", "unknown"]
    // Parse ISO datetimes into JS Dates (past-handling is done by the handlers).
    const parseIso = (s) => {
      if (!s || String(s).toLowerCase() === "null") return null
      const d = new Date(s)
      return isNaN(d.getTime()) ? null : d
    }
    // deadline = the event/due time itself (create uses it for the 12h/1h/0
    // offsets; remind uses it to describe the event in the message).
    const deadline = parseIso(p.deadline_iso) || parseIso(p.event_time_iso)
    // reminderTimes = explicit times to SEND reminders, deduped + sorted.
    const seen = new Set()
    const reminderTimes = (Array.isArray(p.remind_at_iso) ? p.remind_at_iso : [])
      .map(parseIso).filter(Boolean)
      .filter((d) => !seen.has(d.getTime()) && seen.add(d.getTime()))
      .sort((x, y) => x - y)
    return {
      action: valid.includes(p.action) ? p.action : "unknown",
      key: norm(p.key), keys, status: norm(p.status), priority: norm(p.priority), assignee: norm(p.assignee),
      summary: norm(p.summary), commentText: norm(p.comment_text), asked: norm(p.asked),
      reminderText: norm(p.reminder_text), deadline, reminderTimes,
      audience: String(p.audience || "me").toLowerCase() === "all" ? "all" : "me",
    }
  } catch (e) {
    console.error("[webhook] operator interpret failed:", e.message)
    return { action: "unknown" }
  }
}

// Insert a future reminder row. By default it's delivered to the sender's chat
// (ctx.chatId); pass chatId/operatorPhone to target a different recipient (used
// when broadcasting one reminder to every operator).
async function scheduleReminder(userId, ctx, { kind, message, fireAt, ticketKey, chatId, operatorPhone }) {
  await query(
    `insert into wa_reminders (user_id, openwa_session_id, chat_id, operator_phone, kind, message, ticket_key, fire_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [userId, ctx.openwaSessionId, chatId || ctx.chatId,
     operatorPhone !== undefined ? operatorPhone : (ctx.operatorPhone || null),
     kind, message, ticketKey || null, fireAt.toISOString()],
  )
}

// All verified operators for this user, as deliverable recipients.
// chat_id uses the phone-format JID (<digits>@c.us) which OpenWA accepts.
async function listOperatorRecipients(userId) {
  const rows = await query(
    "select phone, label from wa_operators where user_id=$1 order by created_at asc",
    [userId],
  )
  return rows.rows.map((r) => ({
    phone: r.phone,
    label: r.label,
    chatId: `${r.phone}@c.us`,
  }))
}

// Format a Date for display in IST.
function fmtIst(d) {
  return d.toLocaleString("en-GB", { timeZone: "Asia/Kolkata", hour12: true, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) + " IST"
}

// Given a deadline Date, schedule the future reminders (12h before, 1h before,
// at the deadline). Only schedules the ones still in the future. Returns how
// many were scheduled.
async function scheduleDeadlineReminders(userId, ctx, deadline, label, ticketKey) {
  const now = Date.now()
  const offsets = [
    { ms: 12 * 60 * 60 * 1000, text: "in about 12 hours" },
    { ms: 1 * 60 * 60 * 1000, text: "in about 1 hour" },
    { ms: 0, text: "now" },
  ]
  let scheduled = 0
  for (const o of offsets) {
    const fireAt = new Date(deadline.getTime() - o.ms)
    if (fireAt.getTime() <= now + 30 * 1000) continue // skip past/imminent offsets
    const when = o.ms === 0 ? "is due now" : `is due ${o.text} (${fmtIst(deadline)})`
    const msg = ticketKey
      ? `⏰ Reminder: *${ticketKey}* — "${label}" ${when}.`
      : `⏰ Reminder: "${label}" ${when}.`
    await scheduleReminder(userId, ctx, { kind: "deadline", message: msg, fireAt, ticketKey })
    scheduled++
  }
  return scheduled
}

// Pull URLs out of a string (http/https). Used to make sure links the operator
// included in a reminder survive even if the LLM's paraphrase dropped them.
function extractUrls(s) {
  const m = String(s || "").match(/https?:\/\/[^\s]+/gi)
  return m ? Array.from(new Set(m)) : []
}

// First name from an operator label ("jeet parekh" → "Jeet").
function firstName(label) {
  const n = String(label || "").trim().split(/\s+/)[0]
  return n ? n.charAt(0).toUpperCase() + n.slice(1) : ""
}

// Structured WhatsApp reminder message. Links get their own 🔗 line, the event
// time its own 🕒 line, and (for broadcasts) the recipient is greeted by name.
function buildReminderMessage({ name, text, eventTime, urls, team }) {
  const lines = [team ? "⏰ *Team Reminder*" : "⏰ *Reminder*", ""]
  if (name) lines.push(`Hi ${name},`, "")
  lines.push(`📌 ${text}`)
  if (eventTime) lines.push(`🕒 ${fmtIst(eventTime)}`)
  for (const u of urls) lines.push(`🔗 ${u}`)
  return lines.join("\n")
}

// Execute the action and return { reply, keys } (keys = tickets to remember).
// rawBody is the operator's original message, used to recover links the LLM
// may have dropped from reminder_text.
// `spaceKeys` are the Jira projects this sender may act in:
//   []            — no explicit grants; fall back to the pinned project
//   ["HGD"]       — a single-space operator/admin
//   ["HGD","KAN"] — a super admin, or someone granted several spaces
async function runOperatorAction(userId, a, ctx, rawBody, spaceKeys = []) {
  if (a.action === "help") {
    return { reply: [
      "🤖 *What I can do*", "",
      "*Tickets*",
      "• \"how many open tickets?\" / \"list high priority\"",
      "• \"HGD-123\" — ticket details",
      "• \"create a ticket for <issue>\" (add a deadline and I'll remind you)",
      "• \"resolve HGD-123\" / \"reopen HGD-124\"",
      "• \"move HGD-123 to in review\" — any status",
      "• \"comment on HGD-123: waiting for vendor\"",
      "• \"delete HGD-123\" (asks you to confirm)",
      "• \"assign those to <name>\" / \"set HGD-1 to high\"", "",
      "*Reminders*",
      "• \"remind me to <task> by <time>\"",
      "• \"I have a meet at 7:30, remind me at 6:30\" — reminds at both",
      "• \"remind all operators about <thing> at <time>\" (links included)",
      "• \"what's on my schedule?\" / \"do I have any calls today?\"",
    ].join("\n") }
  }

  if (a.action === "capability") {
    const asked = (a.asked || "").trim()
    const cannot = asked ? `I can't ${asked} yet — that's outside what I can do right now.\n\n` : ""
    return { reply: cannot + [
      "Here's what I *can* do:",
      "🎫 *Tickets* — create, delete, comment on, assign, set priority, and move tickets to any status (\"move HGD-1 to in review\"), plus counts, lists and details.",
      "⏰ *Reminders* — personal or team-wide reminders with links, multiple times, and your schedule (\"what's on my schedule?\").",
      "",
      "Send *help* for examples.",
    ].join("\n") }
  }

  if (a.action === "remind") {
    // Links from the original message must survive even if the LLM's clean
    // phrase dropped them; they're shown on their own 🔗 line, so strip them
    // out of the text itself.
    const urls = Array.from(new Set([...extractUrls(rawBody), ...extractUrls(a.reminderText)]))
    let text = (a.reminderText || "").replace(/https?:\/\/[^\s]+/gi, "").replace(/\s{2,}/g, " ").trim()
    if (!text && urls.length) text = "See link"
    if (!text) return { reply: "What should I remind you about? e.g. \"remind me to pay the AWS bill by end of month\". You can include links, say \"all operators\" for the whole team, or give two times (\"remind me at 6:30 for the 7:30 meet\")." }

    // Times to fire at: explicit remind_at list, falling back to the event time.
    let times = a.reminderTimes && a.reminderTimes.length ? a.reminderTimes : (a.deadline ? [a.deadline] : [])
    if (times.length === 0) return { reply: "When should I remind you? Give me a time, e.g. \"tomorrow 5pm\", \"30th 9am\", or \"at 6:30 for the 7:30 meet\"." }
    const future = times.filter((t) => t.getTime() > Date.now() + 30 * 1000)
    if (future.length === 0) return { reply: `That time has already passed (now is ${fmtIst(new Date())}). Give me a future time.` }
    const skipped = times.length - future.length
    times = future

    const timeList = times.map(fmtIst).join("\n🔔 ")
    const skippedNote = skipped ? `\n_(skipped ${skipped} time${skipped === 1 ? "" : "s"} already in the past)_` : ""

    // Broadcast to every operator (each gets a message with their own name),
    // or just the sender.
    if (a.audience === "all") {
      const recipients = await listOperatorRecipients(userId)
      if (recipients.length === 0) {
        return { reply: "You don't have any verified operators to remind yet. Add them in the portal first." }
      }
      for (const r of recipients) {
        const msg = buildReminderMessage({ name: firstName(r.label), text, eventTime: a.deadline, urls, team: true })
        for (const t of times) {
          await scheduleReminder(userId, ctx, {
            kind: "task", message: msg, fireAt: t,
            chatId: r.chatId, operatorPhone: r.phone,
          })
        }
      }
      return { reply: [
        "✅ *Team reminder set*", "",
        `📌 ${text}`,
        ...(a.deadline ? [`🕒 Event: ${fmtIst(a.deadline)}`] : []),
        ...urls.map((u) => `🔗 ${u}`),
        `🔔 ${timeList}`,
        `👥 ${recipients.length} operator${recipients.length === 1 ? "" : "s"}: ${recipients.map((r) => firstName(r.label) || r.phone).join(", ")}`,
      ].join("\n") + skippedNote }
    }

    const msg = buildReminderMessage({ name: null, text, eventTime: a.deadline, urls, team: false })
    for (const t of times) {
      await scheduleReminder(userId, ctx, { kind: "task", message: msg, fireAt: t })
    }
    return { reply: [
      "✅ *Reminder set*", "",
      `📌 ${text}`,
      ...(a.deadline ? [`🕒 Event: ${fmtIst(a.deadline)}`] : []),
      ...urls.map((u) => `🔗 ${u}`),
      `🔔 ${timeList}`,
    ].join("\n") + skippedNote }
  }

  if (a.action === "agenda") {
    // Upcoming reminders addressed to this operator (their own + any broadcasts
    // they're a recipient of). operator_phone holds the recipient's number.
    const phone = ctx.operatorPhone || null
    const rows = await query(
      `select kind, message, fire_at
         from wa_reminders
        where user_id=$1 and operator_phone=$2 and sent=false and fire_at > now()
        order by fire_at asc
        limit 15`,
      [userId, phone],
    )
    if (rows.rows.length === 0) {
      return { reply: "Nothing on your schedule — no upcoming reminders or calls. Set one with \"remind me to <task> at <time>\"." }
    }
    const lines = rows.rows.map((r) => {
      // Strip the leading "⏰ Reminder:"/"⏰ Team reminder:" prefix for a clean agenda view.
      const text = String(r.message).replace(/^⏰\s*(Team reminder|Reminder):\s*/i, "").replace(/\n+/g, " ").trim()
      return `• ${fmtIst(new Date(r.fire_at))} — ${text.slice(0, 120)}`
    })
    return { reply: `Your upcoming schedule (${rows.rows.length}):\n\n${lines.join("\n")}` }
  }

  if (a.action === "create") {
    const summary = (a.summary || "").trim()
    if (!summary) return { reply: "What's the ticket about? e.g. \"create a ticket for the printer being down\"." }
    try {
      const ticket = await jira.createTicket(userId, {
        issueText: summary,
        fromPhone: "operator",
        // One space -> file there. Several (super admin) is ambiguous, so use
        // the connection's pinned project unless the request named a space.
        spaceKey: a.space || (spaceKeys.length === 1 ? spaceKeys[0] : null),
      })
      // Apply optional priority/assignee in one update.
      let extra = ""
      let assigneeName = null
      let priorityName = null
      if (a.priority || a.assignee) {
        const applied = await jira.updateTicket(userId, ticket.key, {
          assigneeQuery: a.assignee || null,
          priorityWord: a.priority || null,
        })
        assigneeName = applied.assignee || null
        priorityName = applied.priority || null
        // "create ... and assign to X" must notify X, exactly like a standalone
        // assign does. Before this only the separate `assign` action notified.
        if (applied.assigneeUser) {
          notifyAssignment({
            userId, assigneeUser: applied.assigneeUser,
            ticket: { key: ticket.key, summary, priority: priorityName, status: "To Do" },
            assignedBy: ctx.operatorLabel || (ctx.operatorPhone ? `+${ctx.operatorPhone}` : null),
            send: (phone, text) => wa.sendText(ctx.session, phone, text),
            session: ctx.session, chatId: ctx.chatId,
          }).catch(() => {})
        }
        // Tell the operator if the named assignee could not be found, rather
        // than silently creating an unassigned ticket.
        if (a.assignee && !applied.assignee) extra = `\n⚠️ Couldn't find a Jira user matching "${a.assignee}" — left unassigned.`
      }
      // Pull it into Service Genie (classify + triage) like WhatsApp-created tickets.
      triggerServiceGenieSync(ticket.key)
      // If the operator stated a deadline, schedule the reminder(s).
      let deadlineNote = ""
      if (a.deadline && a.deadline.getTime() > Date.now()) {
        const n = await scheduleDeadlineReminders(userId, ctx, a.deadline, summary, ticket.key)
        deadlineNote = n > 0 ? `\n⏰ Deadline ${fmtIst(a.deadline)} — I'll remind you before it.` : ""
      }
      return { reply: [
        "✅ *Ticket created*", "",
        `*${ticket.key}*  ${prioIcon(priorityName)} ${priorityName || "Medium"}`,
        summary.slice(0, 120), "",
        `Space:     ${ctx.space || "—"}`,
        `Status:    To Do`,
        `Assignee:  ${assigneeName || "Unassigned"}`,
      ].join("\n") + extra + deadlineNote, keys: [ticket.key] }
    } catch (e) {
      console.error("[webhook] operator create failed:", e.message)
      return { reply: "Sorry, I couldn't create that ticket right now. Please try again shortly." }
    }
  }

  if (a.action === "detail") {
    if (!a.key) return { reply: "Which ticket? Send the key, e.g. HGD-123." }
    const t = await jira.getTicket(userId, a.key)
    if (!t) return { reply: `I couldn't find ${a.key}.` }
    return { reply: fmtTicket(t) + (t.reporter ? `\nReporter: ${t.reporter}` : ""), keys: [t.key] }
  }

  if (a.action === "count") {
    const { filter, descParts, error } = await buildFilter(userId, a)
    if (error) return { reply: error }
    const n = await jira.countIssues(userId, filter, spaceKeys)
    ctx.lastFilter = { status: a.status, priority: a.priority, assignee: a.assignee }
    const desc = descParts.join(", ")
    return { reply: `There ${n === 1 ? "is" : "are"} *${n}* ticket${n === 1 ? "" : "s"}${desc ? " " + desc : ""}.` }
  }

  if (a.action === "list") {
    const { filter, descParts, error } = await buildFilter(userId, a)
    if (error) return { reply: error }
    const items = await jira.searchIssues(userId, filter, 10, spaceKeys)
    ctx.lastFilter = { status: a.status, priority: a.priority, assignee: a.assignee }
    if (items.length === 0) return { reply: "No tickets match that.", keys: [] }
    const desc = descParts.join(", ")
    const reply = fmtTicketList(items, desc)
    return { reply, keys: items.map((t) => t.key) }
  }

  if (a.action === "recent") {
    const items = await jira.searchIssues(userId, null, 5, spaceKeys)
    if (items.length === 0) return { reply: "No tickets yet.", keys: [] }
    const reply = `Most recently updated:\n\n` +
      items.map((t) => `• *${t.key}* (${t.status}) — ${t.summary.slice(0, 45)}`).join("\n")
    return { reply, keys: items.map((t) => t.key) }
  }

  // ── Write actions ───────────────────────────────────────────────────────────
  const targetKeys = (a.keys && a.keys.length ? a.keys : (a.key ? [a.key] : ctx.lastKeys)).slice(0, 10)

  if (a.action === "resolve" || a.action === "reopen") {
    if (targetKeys.length === 0) return { reply: `Which ticket(s) should I ${a.action}? Tell me the key, e.g. ${a.action} HGD-123.` }
    // Resolve → Done category. Reopen → move OUT of Done into the active
    // (indeterminate / In Progress) category; most workflows don't allow going
    // all the way back to To Do, so "indeterminate" is the reliable reopen target.
    const targetCat = a.action === "resolve" ? "done" : "indeterminate"
    const results = []
    for (const k of targetKeys) {
      try {
        const r = await jira.transitionToCategory(userId, k, targetCat)
        results.push(r.ok ? `${k} → ${r.finalStatus}` : `${k} (couldn't: ${r.reason})`)
      } catch (e) { results.push(`${k} (error)`) }
    }
    const verb = a.action === "resolve" ? "Resolved" : "Reopened"
    return { reply: `${verb}:\n` + results.map((r) => `• ${r}`).join("\n"), keys: targetKeys }
  }

  if (a.action === "assign") {
    if (targetKeys.length === 0) return { reply: "Which ticket(s) should I assign? Tell me the key." }
    if (!a.assignee) return { reply: "Assign to whom? Give me a name or email." }
    const out = []
    for (const k of targetKeys) {
      const applied = await jira.updateTicket(userId, k, { assigneeQuery: a.assignee })
      out.push(applied.assignee ? `${k} → ${applied.assignee}` : `${k} (user not found)`)
      // Tell the assignee. Never lets a notify failure fail the assignment.
      if (applied.assigneeUser) {
        const t = await jira.getTicket(userId, k).catch(() => ({ key: k }))
        notifyAssignment({
          userId, assigneeUser: applied.assigneeUser, ticket: t || { key: k },
          assignedBy: ctx.operatorLabel || (ctx.operatorPhone ? `+${ctx.operatorPhone}` : null),
          send: (phone, text) => wa.sendText(ctx.session, phone, text),
          session: ctx.session, chatId: ctx.chatId,
        }).catch(() => {})
      }
    }
    return { reply: "Assignment:\n" + out.map((r) => `• ${r}`).join("\n"), keys: targetKeys }
  }

  if (a.action === "set_priority") {
    if (targetKeys.length === 0) return { reply: "Which ticket(s)? Tell me the key." }
    if (!a.priority) return { reply: "What priority? e.g. high, medium, low." }
    const out = []
    for (const k of targetKeys) {
      const applied = await jira.updateTicket(userId, k, { priorityWord: a.priority })
      out.push(applied.priority ? `${k} → ${applied.priority}` : `${k} (couldn't set)`)
    }
    return { reply: "Priority:\n" + out.map((r) => `• ${r}`).join("\n"), keys: targetKeys }
  }

  if (a.action === "set_status") {
    if (targetKeys.length === 0) return { reply: "Which ticket(s) should I move? Tell me the key, e.g. \"move HGD-123 to in review\"." }
    if (!a.status) return { reply: "Which status should I move it to? e.g. \"in progress\", \"in review\", \"done\"." }
    const out = []
    for (const k of targetKeys) {
      try {
        const r = await jira.transitionToStatus(userId, k, a.status)
        out.push(r.ok ? `${k} → *${r.finalStatus}*` : `${k} — couldn't reach "${a.status}" (${r.reason}${r.finalStatus ? `, currently ${r.finalStatus}` : ""})`)
      } catch (e) { out.push(`${k} (error)`) }
    }
    return { reply: "🔀 *Status updated*\n" + out.map((r) => `• ${r}`).join("\n"), keys: targetKeys }
  }

  if (a.action === "comment") {
    if (targetKeys.length === 0) return { reply: "Which ticket should I comment on? e.g. \"comment on HGD-123: waiting for vendor\"." }
    const text = (a.commentText || "").trim()
    if (!text) return { reply: "What should the comment say? e.g. \"comment on HGD-123: waiting for vendor\"." }

    // Access gate: a ticket key encodes its project (HGD-12 -> HGD). Only
    // allow comments on tickets whose project is one of the sender's spaces.
    // Without this, an operator scoped to HGD could comment on KAN-5 just by
    // naming it — the space picker scopes *listing*, but a typed key bypasses
    // that, so the write path needs its own check.
    const allowedSpaces = new Set((spaceKeys || []).map((k) => String(k).toUpperCase()))
    const denied = targetKeys.filter((k) => {
      const proj = String(k).split("-")[0].toUpperCase()
      return allowedSpaces.size > 0 && !allowedSpaces.has(proj)
    })
    if (denied.length) {
      return { reply: `You don't have access to ${denied.join(", ")}. You can comment on tickets in: ${[...allowedSpaces].join(", ") || "your assigned space"}.` }
    }
    const out = []
    for (const k of targetKeys) {
      try {
        const r = await jira.addComment(userId, k, text)
        out.push(r.ok ? `${k} ✓` : `${k} — failed (${r.reason})`)
      } catch (e) { out.push(`${k} (error)`) }
    }
    return { reply: [
      "💬 *Comment added*", "",
      `"${text.slice(0, 120)}"`,
      out.map((r) => `• ${r}`).join("\n"),
    ].join("\n"), keys: targetKeys }
  }

  if (a.action === "delete") {
    if (targetKeys.length === 0) return { reply: "Which ticket(s) should I delete? Tell me the key, e.g. \"delete HGD-123\"." }
    // Deletion is permanent — require an explicit confirmation message.
    ctx.pendingDelete = { keys: targetKeys, at: Date.now() }
    return { reply: [
      "⚠️ *Confirm deletion*", "",
      `This will *permanently delete* ${targetKeys.length === 1 ? "ticket" : "these tickets"}:`,
      targetKeys.map((k) => `• ${k}`).join("\n"),
      "",
      "Reply *confirm* to delete, or anything else to cancel.",
    ].join("\n"), keys: targetKeys }
  }

  return { reply: null }
}

// ── Conversation state (DB-backed, per user+sender) ──────────────────────────
async function getState(userId, chatId) {
  let row = await one("select * from wa_conversations where user_id=$1 and sender_chat_id=$2", [userId, chatId])
  if (!row) {
    row = await one(
      "insert into wa_conversations (user_id, sender_chat_id, step) values ($1,$2,'idle') returning *",
      [userId, chatId],
    )
  }
  return row
}
async function setState(userId, chatId, step, senderPhone, lastTicketKey) {
  await query(
    `update wa_conversations
       set step=$1,
           sender_phone=coalesce($2, sender_phone),
           last_ticket_key=$3,
           updated_at=now()
     where user_id=$4 and sender_chat_id=$5`,
    [step, senderPhone || null, lastTicketKey ?? null, userId, chatId],
  )
}

// Resolve a @lid privacy address to a real phone via the contact API.
async function resolvePhone(sessionId, chatId) {
  if (chatId.endsWith("@c.us")) return chatId.split("@")[0]
  const contact = await openwa.resolveContact(sessionId, chatId)
  const realId = String(contact?.id || "")
  if (realId.endsWith("@c.us")) return realId.split("@")[0]
  return chatId.split("@")[0]
}

// ── Shared inbound processor ─────────────────────────────────────────────────
// Consumes a NORMALISED event that both providers produce:
//   { session, userId, fromPhone, chatId, body }
//     session — send descriptor: {openwaSessionId} OR {phoneNumberId, accessToken}
//     userId  — the tenant who owns the number this message arrived on
//     fromPhone — sender phone (bare digits)
//     chatId  — reply address (OpenWA: <phone>@c.us/@lid; Cloud: the phone)
//     body    — message text
// All sends go through wa.sendText(session, chatId, text) so the provider is
// abstracted. The ticket / operator / reminder logic is identical for both.
async function processInbound(evt) {
  const { session, userId, chatId, body } = evt
  const fromPhone = evt.fromPhone
  const sendText = (t) => wa.sendText(session, chatId, t)

  try {
    // Must have a Jira connection + project before we can create tickets.
    const conn = await one(
      "select project_key from wa_jira_connections where user_id=$1 and status='active'",
      [userId],
    )
    // Don't log message bodies (PII). Log only metadata + length.
    console.log(`[webhook] user=${userId.slice(0,8)} from=+${fromPhone} len=${body.length}`)

    if (!conn || !conn.project_key) {
      await sendText("This support line isn't fully set up yet (no Jira project connected). Please try again later.")
      return
    }

    // ── Verified-operator query path ──────────────────────────────────────────
    // If the sender is a trusted operator, treat their message as a Jira query
    // (status/priority/counts/recent/create/resolve/reminders) instead of a
    // customer ticket. Operators ALWAYS get the Jira assistant — the customer
    // "hi genie" support flow is for non-operator numbers only.
    const operator = await getOperator(userId, fromPhone)
    if (operator) {
      const ctxKey = `${userId}:${chatId}`
      const ctx = getCtx(ctxKey)
      // Carry delivery coordinates so reminder-scheduling actions know where to
      // send. `session` is the provider send descriptor (used by reminders).
      ctx.session = session
      ctx.openwaSessionId = session && session.openwaSessionId  // legacy compat
      ctx.chatId = chatId
      ctx.operatorPhone = fromPhone
      ctx.operatorLabel = operator.label || null

      // ── Pending-delete confirmation ────────────────────────────────────────
      // Deleting is irreversible, so the delete action stashes the keys here
      // and asks for confirmation. "confirm"/"yes" executes; anything else
      // cancels and falls through to normal interpretation. Expires in 2 min.
      if (ctx.pendingDelete) {
        const pending = ctx.pendingDelete
        delete ctx.pendingDelete
        const fresh = Date.now() - pending.at < 2 * 60 * 1000
        if (fresh && /^(confirm|yes|y|yes delete|delete them|go ahead|do it)\.?$/i.test(body.trim())) {
          const out = []
          for (const k of pending.keys) {
            try {
              const r = await jira.deleteTicket(userId, k)
              out.push(r.ok ? `${k} 🗑️ deleted` : `${k} — failed (${r.reason})`)
            } catch (e) { out.push(`${k} (error)`) }
          }
          await sendText("🗑️ *Deletion result*\n" + out.map((r) => `• ${r}`).join("\n"))
          console.log(`[webhook] operator +${fromPhone} deleted: ${pending.keys.join(",")}`)
          return
        }
        if (fresh && /^(no|nope|cancel|stop|don'?t|nah)\.?$/i.test(body.trim())) {
          await sendText("Okay, cancelled — nothing was deleted.")
          return
        }
        // Any other message (or expired) cancels silently and is interpreted
        // as a normal command below.
      }

      // ── Space selection ────────────────────────────────────────────────────
      // Every operator action is scoped to ONE Jira project ("space"). The
      // chosen space lives on the per-operator context. Until one is chosen we
      // do not interpret the message as a command at all — we ask first.
      //
      //   "switch space" / "change space" / "spaces"  -> re-open the picker
      //   a tapped list row (interactiveId "space:HGD") -> select HGD
      //   a bare project key typed ("HGD")              -> select HGD
      //
      // One allowed space is auto-selected silently: a picker with a single
      // row is just friction.
      const spaceListId = "space:"
      const trimmed = body.trim()
      const wantsSwitch = /^(switch|change|choose|select|pick)\s+(space|project)s?\.?$|^spaces?\.?$/i.test(trimmed)
      const tappedSpace = evt.interactiveId && evt.interactiveId.startsWith(spaceListId)
        ? evt.interactiveId.slice(spaceListId.length) : null

      if (wantsSwitch || tappedSpace || !ctx.space) {
        // Which spaces can this sender see?
        //   super_admin -> EVERY project on the Jira site. They must be able to
        //     open HASH or KAN even if no explicit grant names them.
        //   admin       -> every project on the site, narrowed to their grants.
        //   operator    -> only the projects they were granted.
        //   no grants   -> the connection's pinned project (legacy install).
        let spaces = []
        if (operator.role === "admin" || operator.role === "super_admin") {
          spaces = await jira.listProjects(userId).then((ps) => ps.map((x) => x.key)).catch(() => [])
          if (operator.role === "admin" && operator.spaces.length) {
            spaces = spaces.filter((k) => operator.spaces.includes(k))
          }
        }
        if (!spaces.length) spaces = await resolveSpaceKeys(userId, operator.phone, jira).catch(() => [])
        if (!spaces.length && conn && conn.project_key) spaces = [conn.project_key]

        if (spaces.length === 0) {
          await sendText("No Jira space is set up for you yet. Ask the portal owner to add you to a project.")
          return
        }

        // A tap, or a typed key matching an allowed space, selects it.
        const typedKey = trimmed.toUpperCase()
        const pick = tappedSpace && spaces.includes(tappedSpace.toUpperCase())
          ? tappedSpace.toUpperCase()
          : (!wantsSwitch && spaces.includes(typedKey) ? typedKey : null)

        if (pick) {
          ctx.space = pick
          ctx.lastKeys = []; ctx.lastFilter = null  // context from another space is stale
          await sendText(
            `✅ *Space: ${pick}*\n\n` +
            `You're now working in ${pick}. Try:\n` +
            `• _how many open?_\n` +
            `• _create a ticket for <issue>_\n` +
            `• _assign ${pick}-12 to <name>_\n\n` +
            `Say *switch space* to change.`,
          )
          return
        }

        // No space selected yet, or they asked to switch: ALWAYS show the
        // picker. Even with a single space the explicit choice is the point —
        // the operator should know which project they are acting in. The old
        // behaviour auto-selected a lone space silently, which is why the
        // picker never appeared for anyone granted only HGD.
        await sendSpacePicker(session, chatId, spaces, sendText)
        return
      }

      try {
        const a = await interpretOperator(body, ctx)
        if (a.action === "unknown") {
          await sendText(
            "I can help with your Jira tickets and reminders — try \"how many open?\", \"create a ticket for <issue>\", \"HGD-123\", \"resolve HGD-123\", \"remind me to <task> at <time>\", or \"what's on my schedule?\".")
          return
        }
        // Scope strictly to the selected space (never the whole allowed set):
        // a super admin sees one project at a time, chosen via the picker.
        const { reply: answer, keys } = await runOperatorAction(userId, a, ctx, body, [ctx.space])
        const finalReply = answer || "Sorry, I couldn't do that."
        await sendText(finalReply)
        // Update conversation context: remember the turn + any tickets surfaced.
        ctx.history.push({ role: "user", content: body.slice(0, 300) })
        ctx.history.push({ role: "assistant", content: finalReply.slice(0, 300) })
        if (ctx.history.length > 12) ctx.history = ctx.history.slice(-12)
        if (Array.isArray(keys) && keys.length) ctx.lastKeys = keys
        ctx.at = Date.now()
        console.log(`[webhook] operator +${fromPhone} action=${a.action} keys=${(a.keys||[]).length}`)
      } catch (e) {
        console.error("[webhook] operator action failed:", e.message)
        await sendText("Sorry, I couldn't reach Jira right now. Please try again shortly.")
      }
      return
    }

    // Non-operator (customer) support flow below.
    const state = await getState(userId, chatId)
    const lower = body.toLowerCase().trim()
    const reply = (t) => sendText(t)

    // ── GLOBAL TRIGGER: "hi genie" (re)starts the flow from any state ──────────
    if (lower === TRIGGER_PHRASE) {
      await setState(userId, chatId, "awaiting_issue", fromPhone, null)
      await reply(GREETING)
      return
    }

    // ── STATE: awaiting_assist (after a ticket was just created) ──────────────
    if (state.step === "awaiting_assist") {
      const parsed = await parseAssistReply(body)

      if (parsed.intent === "no_further") {
        await reply("Thank you! If you need anything else, just message \"" + TRIGGER_PHRASE + "\". Have a great day.")
        await setState(userId, chatId, "idle", fromPhone, null)
        return
      }

      if (parsed.intent === "provide_details") {
        const key = state.last_ticket_key
        if (!key) {
          await reply("Sorry, I lost track of your ticket. Please message \"" + TRIGGER_PHRASE + "\" to start again.")
          await setState(userId, chatId, "idle", fromPhone, null)
          return
        }
        try {
          const applied = await jira.updateTicket(userId, key, {
            assigneeQuery: parsed.assignee,
            priorityWord: parsed.priority,
          })
          const bits = []
          if (applied.assignee) bits.push(`assigned to ${applied.assignee}`)
          if (applied.priority) bits.push(`priority set to ${applied.priority}`)
          const noteWanted = []
          if (parsed.assignee && !applied.assignee) noteWanted.push(`couldn't find a Jira user matching "${parsed.assignee}"`)
          if (parsed.priority && !applied.priority) noteWanted.push(`couldn't apply priority "${parsed.priority}"`)

          let msg = `Ticket ${key} updated`
          if (bits.length) msg += ` — ${bits.join(", ")}`
          msg += "."
          if (noteWanted.length) msg += ` (Note: ${noteWanted.join("; ")}.)`
          msg += " Thank you for reaching out — our team will follow up shortly."
          await reply(msg)
          console.log(`[webhook] updated ${key}: assignee=${applied.assignee} priority=${applied.priority}`)
        } catch (e) {
          console.error("[webhook] ticket update failed:", e.message)
          await reply(`Sorry, I couldn't update ticket ${key} right now. Our team will still see your request. Thank you.`)
        }
        await setState(userId, chatId, "idle", fromPhone, null)
        return
      }

      // irrelevant → thank + end
      await reply("Thank you for reaching out. If you need help again, just message \"" + TRIGGER_PHRASE + "\".")
      await setState(userId, chatId, "idle", fromPhone, null)
      return
    }

    // ── STATE: idle (waiting for the trigger word) ────────────────────────────
    if (state.step === "idle") {
      // Only the trigger word starts a conversation. Anything else is ignored
      // (handled above). Stay quiet so we don't reply to random messages.
      return
    }

    // ── STATE: awaiting_issue → judge + create ticket ─────────────────────────
    const relevant = await isRelevantIssue(body)
    if (!relevant) {
      await reply([
        "Here's what I can do for you:",
        "🎫 Create a support ticket — just describe your problem or request in a message.",
        "✍️ After the ticket is created, you can ask me to assign it to someone or set its priority.",
        "",
        "I can't do other things (like checking systems or answering general questions) — our team handles those once your ticket is in.",
        "",
        "So, what's the issue you need help with?",
      ].join("\n"))
      return
    }

    try {
      const ticket = await jira.createTicket(userId, { issueText: body, fromPhone })
      await query(
        "insert into wa_tickets (user_id, jira_key, jira_url, sender_phone, issue_text) values ($1,$2,$3,$4,$5)",
        [userId, ticket.key, ticket.url, fromPhone, body],
      )
      await reply(`A support ticket has been created (${ticket.key}). ${ASSIST_PROMPT}`)
      // Immediately pull this ticket into Service Genie (classify + triage)
      // instead of waiting for the 5-min worker. Fire-and-forget.
      triggerServiceGenieSync(ticket.key)
      // Move to awaiting_assist, remembering the ticket key for the follow-up.
      await setState(userId, chatId, "awaiting_assist", fromPhone, ticket.key)
      console.log(`[webhook] created ${ticket.key} for user ${userId.slice(0,8)} — awaiting assist`)
    } catch (e) {
      console.error("[webhook] ticket creation failed:", e.message)
      await reply("Sorry, something went wrong creating your ticket. Please try again shortly.")
      await setState(userId, chatId, "idle", fromPhone, null)
    }
  } catch (e) {
    console.error("[webhook] handler error:", e.message)
  }
}

// ── Legacy OpenWA webhook ────────────────────────────────────────────────────
// Normalises the OpenWA payload into the shared event and hands off to
// processInbound. Kept for the transition; disabled once WHATSAPP_PROVIDER=cloud
// everywhere.
router.post("/webhook/:secret", webhookLimiter, async (req, res) => {
  if (!WEBHOOK_SECRET || req.params.secret !== WEBHOOK_SECRET) {
    return res.status(404).json({ error: "not_found" }) // 404 to avoid confirming the path
  }
  res.json({ ok: true }) // ack immediately

  try {
    const evt = req.body || {}
    if (evt.event !== "message.received") return
    const d = evt.data || {}
    if (d.fromMe || d.isGroup) return
    const TEXT_TYPES = new Set(["chat", "text"])
    if (d.type && !TEXT_TYPES.has(d.type)) return

    const openwaSessionId = evt.sessionId
    const chatId = d.from
    const body = (d.body || "").trim()
    if (!openwaSessionId || !chatId || !body) return

    const sess = await one("select user_id from wa_sessions where openwa_session_id=$1", [openwaSessionId])
    if (!sess) { console.warn("[webhook] no user for session", openwaSessionId); return }

    const fromPhone = await resolvePhone(openwaSessionId, chatId)
    await processInbound({
      session: { openwaSessionId },
      userId: sess.user_id,
      fromPhone,
      chatId,
      body,
    })
  } catch (e) {
    console.error("[webhook] legacy handler error:", e.message)
  }
})

module.exports = {
  webhookRouter: router,
  processInbound,              // consumed by the Cloud webhook (webhook-cloud.js)
  _test: { interpretOperator, buildReminderMessage, firstName },
}
