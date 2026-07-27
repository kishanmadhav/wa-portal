// Reminder delivery. A systemd timer on the box POSTs to /reminders/due every
// minute with the webhook secret. We find reminders whose fire_at has passed
// and that haven't been sent, send each via the active WhatsApp provider, and
// mark them sent.
//
// NOTE (Cloud API): a reminder fired long after the operator last messaged may
// fall OUTSIDE Meta's 24h customer-service window, which rejects free-form text.
// When that happens the send throws and we leave the reminder unsent (it will
// keep retrying). A proper fix is a pre-approved "reminder" template — tracked
// as a Phase-3 follow-up. Within 24h (the common case for deadline reminders)
// the plain-text send works.
const express = require("express")
const { all, query } = require("../lib/db")
const wa = require("../lib/wa")

const router = express.Router()

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || ""

// POST /reminders/due/:secret — process due reminders. Secret in the path so the
// timer can authenticate the same way the webhook does.
router.post("/due/:secret", async (req, res) => {
  if (!WEBHOOK_SECRET || req.params.secret !== WEBHOOK_SECRET) {
    return res.status(404).json({ error: "not_found" })
  }

  try {
    // Grab due, unsent reminders (cap per run so a backlog doesn't stall).
    // Join wa_sessions to get the provider send credentials for the tenant.
    const due = await all(
      `select r.id, r.openwa_session_id, r.chat_id, r.message, r.operator_phone,
              s.phone_number_id, s.access_token
         from wa_reminders r
         left join wa_sessions s on s.user_id = r.user_id
        where r.sent = false and r.fire_at <= now()
        order by r.fire_at asc
        limit 50`,
    )

    let sent = 0
    for (const r of due) {
      try {
        // Build the provider send descriptor. Cloud: phone_number_id + token;
        // OpenWA: the legacy session id. Recipient: operator phone (Cloud) or
        // the stored chat_id (OpenWA).
        const session = wa.isCloud()
          ? { phoneNumberId: r.phone_number_id, accessToken: r.access_token }
          : { openwaSessionId: r.openwa_session_id }
        const recipient = wa.isCloud() ? (r.operator_phone || r.chat_id) : r.chat_id
        await wa.sendText(session, recipient, r.message)
        await query("update wa_reminders set sent=true, sent_at=now() where id=$1", [r.id])
        sent++
      } catch (e) {
        // Leave sent=false so it retries next minute (session down, or outside
        // the 24h window on Cloud).
        console.error(`[reminders] send failed for ${r.id}:`, e.message)
      }
    }

    res.json({ ok: true, due: due.length, sent })
  } catch (e) {
    console.error("[reminders/due]", e.message)
    res.status(500).json({ error: "reminders_failed", detail: e.message })
  }
})

module.exports = { remindersRouter: router }
