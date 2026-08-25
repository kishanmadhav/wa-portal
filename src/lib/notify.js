// Assignee notifications over WhatsApp.
//
// Matching a Jira user to a phone tries, in order:
//   1. email  — wa_space_roles.email vs the assignee's Jira email (exact)
//   2. name   — wa_space_roles.label vs the assignee's Jira displayName
//               (case-insensitive; also tolerates "First Last" vs "first last")
// Name is the primary path in practice: the portal owner types a name when
// adding someone, and rarely an email.
//
// Nothing here may fail the calling operation. A missing mapping or a Meta
// send error is logged and swallowed — assigning/updating the ticket is the
// real work; the message is a courtesy.
const { one, query } = require("./db")

function normPhone(p) { return String(p || "").replace(/\D+/g, "") }
function normName(s)  { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() }

// Resolve a Jira user -> { phone, label } or null.
async function phoneForAssignee(userId, assigneeUser) {
  if (!assigneeUser) return null
  const email = String(assigneeUser.email || "").trim().toLowerCase()
  if (email) {
    const byEmail = await one(
      `select phone, label from wa_space_roles
        where user_id=$1 and lower(email)=$2 limit 1`, [userId, email])
    if (byEmail) return byEmail
  }
  const name = normName(assigneeUser.displayName)
  if (!name) return null
  // Compare normalised names in SQL so "Neeraj" matches "neeraj" and
  // "Harsh Yadav" matches "harsh  yadav".
  return one(
    `select phone, label from wa_space_roles
      where user_id=$1
        and regexp_replace(lower(coalesce(label,'')), '[^a-z0-9]+', ' ', 'g') = $2
      limit 1`, [userId, name])
}

function ticketLine(t) {
  return `*${t.key}* — ${String(t.summary || "").slice(0, 100)}` +
    (t.priority ? `\nPriority: ${t.priority}` : "") +
    (t.status ? `\nStatus: ${t.status}` : "")
}

// Assignment: alert now + schedule a 24h nudge until resolved.
async function notifyAssignment({ userId, assigneeUser, ticket, assignedBy, send, session, chatId }) {
  try {
    const target = await phoneForAssignee(userId, assigneeUser)
    if (!target) {
      console.log(`[notify] no phone for "${assigneeUser?.displayName}"; skipping`)
      return { sent: false, reason: "no_phone_mapping" }
    }
    const phone = normPhone(target.phone)
    await send(phone, `📌 *Assigned to you*\n\n${ticketLine(ticket)}` +
      (assignedBy ? `\nAssigned by: ${assignedBy}` : "") +
      `\n\nReply *${ticket.key}* for details, or *comment on ${ticket.key}: <text>*.`)

    // 24h nudge. Upsert so reassignment replaces rather than stacks.
    await query(
      `insert into wa_reminders
         (user_id, openwa_session_id, chat_id, operator_phone, recipient_phone,
          kind, message, ticket_key, fire_at, interval_hours)
       values ($1,$2,$3,$4,$5,'assignment',$6,$7, now() + interval '24 hours', 24)
       on conflict (user_id, ticket_key, recipient_phone) where kind='assignment' and sent=false
         do update set fire_at = now() + interval '24 hours', message = excluded.message`,
      [userId, session?.openwaSessionId || "", chatId || phone, phone, phone,
       `⏰ *Still open — assigned to you*\n\n${ticketLine(ticket)}\n\nReply *${ticket.key}* for details.`,
       ticket.key],
    )
    return { sent: true, phone }
  } catch (e) {
    console.error("[notify] assignment failed:", e.message)
    return { sent: false, reason: e.message }
  }
}

// Status change / new comment on a ticket the person is assigned to.
async function notifyUpdate({ userId, assigneeUser, ticket, change, send }) {
  try {
    const target = await phoneForAssignee(userId, assigneeUser)
    if (!target) return { sent: false, reason: "no_phone_mapping" }
    const phone = normPhone(target.phone)
    let body
    if (change.type === "status") {
      body = `🔄 *Status changed*\n\n${ticketLine(ticket)}\n\n${change.from || "—"} → *${change.to}*`
    } else if (change.type === "comment") {
      body = `💬 *New comment*\n\n*${ticket.key}* — ${String(ticket.summary || "").slice(0, 80)}\n\n` +
        `${change.author ? `_${change.author}:_ ` : ""}${String(change.text || "").slice(0, 400)}`
    } else {
      body = `✏️ *Ticket updated*\n\n${ticketLine(ticket)}`
    }
    if (change.by) body += `\n\n_by ${change.by}_`
    await send(phone, body)
    // A resolved ticket stops nudging.
    if (change.type === "status" && /done|resolved|closed|complete/i.test(change.to || "")) {
      await query(
        `update wa_reminders set sent=true, sent_at=now()
          where user_id=$1 and ticket_key=$2 and kind='assignment' and sent=false`,
        [userId, ticket.key])
    }
    return { sent: true, phone }
  } catch (e) {
    console.error("[notify] update failed:", e.message)
    return { sent: false, reason: e.message }
  }
}

module.exports = { notifyAssignment, notifyUpdate, phoneForAssignee }
