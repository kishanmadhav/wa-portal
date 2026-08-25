// Assignment notifications over WhatsApp.
//
// When a ticket is assigned, find the phone that belongs to the assignee and
// message them. The link between a Jira user and a phone is the `email` on
// their role grant (wa_space_roles.email) — Jira returns the assignee's email,
// and the portal owner supplies the email when adding someone.
//
// This must NEVER fail the assignment itself: a missing mapping or a Meta send
// error is logged and swallowed. Assigning a ticket is the real work; the
// notification is a courtesy.
const { one } = require("./db")

function normPhone(p) {
  return String(p || "").replace(/\D+/g, "")
}

// Resolve a Jira user -> { phone, label } or null when nobody is mapped.
async function phoneForAssignee(userId, assigneeUser) {
  if (!assigneeUser) return null
  const email = String(assigneeUser.email || "").trim().toLowerCase()
  if (!email) return null
  return one(
    `select phone, label from wa_space_roles
      where user_id = $1 and lower(email) = $2
      limit 1`,
    [userId, email],
  )
}

// Send the notification. `send(phone, text)` is injected so this module has no
// dependency on which WhatsApp provider is active.
async function notifyAssignment({ userId, assigneeUser, ticket, assignedBy, send }) {
  try {
    const target = await phoneForAssignee(userId, assigneeUser)
    if (!target) {
      console.log(`[notify] no phone mapped for ${assigneeUser?.email || "assignee"}; skipping`)
      return { sent: false, reason: "no_phone_mapping" }
    }
    const text =
      `You've been assigned a ticket.\n\n` +
      `*${ticket.key}* — ${String(ticket.summary || "").slice(0, 120)}\n` +
      (ticket.priority ? `Priority: ${ticket.priority}\n` : "") +
      (ticket.status ? `Status: ${ticket.status}\n` : "") +
      (assignedBy ? `Assigned by: ${assignedBy}\n` : "") +
      `\nReply with the ticket key to see details.`
    await send(normPhone(target.phone), text)
    return { sent: true, phone: target.phone }
  } catch (e) {
    console.error("[notify] assignment notification failed:", e.message)
    return { sent: false, reason: e.message }
  }
}

module.exports = { notifyAssignment, phoneForAssignee }
