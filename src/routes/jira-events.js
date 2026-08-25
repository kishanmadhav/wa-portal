// Inbound Jira webhook: Jira POSTs here on issue updates and new comments.
// We forward status changes and comments to the ticket's assignee over
// WhatsApp, if their name/email maps to a known phone.
//
// Auth: Jira Cloud OAuth webhooks do not sign payloads. The per-connection
// secret in the URL path is the credential — unguessable, and a leak exposes
// exactly one tenant. Constant-time compare so timing can't leak it.
const express = require("express")
const crypto = require("crypto")
const { one } = require("../lib/db")
const wa = require("../lib/wa")
const jira = require("../lib/jira")
const { notifyUpdate } = require("../lib/notify")

const router = express.Router()

function safeEqual(a, b) {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""))
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

router.post("/:secret", express.json({ limit: "2mb" }), async (req, res) => {
  // Ack fast: Jira retries on non-2xx and we don't want duplicate messages.
  res.status(200).json({ ok: true })

  try {
    const conn = await one(
      "select user_id, jira_webhook_secret from wa_jira_connections where jira_webhook_secret is not null and status='active' and jira_webhook_secret=$1",
      [req.params.secret],
    )
    if (!conn || !safeEqual(conn.jira_webhook_secret, req.params.secret)) return
    const userId = conn.user_id

    const ev = req.body || {}
    const issue = ev.issue
    if (!issue || !issue.key) return
    const f = issue.fields || {}
    const assignee = f.assignee
      ? { accountId: f.assignee.accountId, displayName: f.assignee.displayName, email: f.assignee.emailAddress || null }
      : null
    if (!assignee) return  // nobody to tell

    const ticket = { key: issue.key, summary: f.summary, priority: f.priority?.name, status: f.status?.name }
    const sess = await one("select phone_number_id, access_token, openwa_session_id from wa_sessions where user_id=$1", [userId])
    if (!sess) return
    const session = wa.isCloud()
      ? { phoneNumberId: sess.phone_number_id, accessToken: sess.access_token }
      : { openwaSessionId: sess.openwa_session_id }
    const send = (phone, text) => wa.sendText(session, phone, text)
    const by = ev.user?.displayName || null

    if (ev.webhookEvent === "comment_created" && ev.comment) {
      const text = ev.comment.body?.content
        ? flattenAdf(ev.comment.body)          // ADF (v3)
        : String(ev.comment.body || "")        // plain (v2)
      await notifyUpdate({ userId, assigneeUser: assignee, ticket,
        change: { type: "comment", text, author: ev.comment.author?.displayName, by }, send })
      return
    }

    if (ev.webhookEvent === "jira:issue_updated") {
      const items = ev.changelog?.items || []
      const st = items.find((i) => i.field === "status")
      if (st) {
        await notifyUpdate({ userId, assigneeUser: assignee, ticket,
          change: { type: "status", from: st.fromString, to: st.toString, by }, send })
        return
      }
      // A reassignment TO this person is handled at the point of assignment
      // by the bot; other field edits (priority etc.) get a generic ping.
      const meaningful = items.filter((i) => !["assignee", "status", "resolution"].includes(i.field))
      if (meaningful.length) {
        await notifyUpdate({ userId, assigneeUser: assignee, ticket, change: { type: "edit", by }, send })
      }
    }
  } catch (e) {
    console.error("[jira-events]", e.message)
  }
})

// Atlassian Document Format -> plain text (comments arrive as ADF on v3).
function flattenAdf(node, out = []) {
  if (!node) return out.join("")
  if (node.type === "text" && node.text) out.push(node.text)
  if (node.type === "hardBreak" || node.type === "paragraph") out.push(out.length ? "\n" : "")
  for (const c of node.content || []) flattenAdf(c, out)
  return out.join("").replace(/\n{3,}/g, "\n\n").trim()
}

module.exports = { jiraEventsRouter: router }
