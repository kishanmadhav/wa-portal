// Verified-operator management. Each portal user maintains their own list of
// phone numbers allowed to QUERY their Jira workspace over WhatsApp.
const express = require("express")
const { all, one, query } = require("../lib/db")
const { requireAuth } = require("./auth")

const router = express.Router()

// Normalise a phone to digits only, so "+91 7358350698", "917358350698", and
// "(91) 7358350698" all compare equal.
function normPhone(p) {
  return String(p || "").replace(/\D+/g, "")
}

// GET /operators — list this user's verified operators.
router.get("/", requireAuth, async (req, res) => {
  const rows = await all(
    "select id, phone, label, created_at from wa_operators where user_id=$1 order by created_at desc",
    [req.userId],
  )
  res.json({ ok: true, operators: rows })
})

// POST /operators — add one.  { phone, label? }
router.post("/", requireAuth, async (req, res) => {
  const phone = normPhone(req.body.phone)
  const label = String(req.body.label || "").trim() || null
  if (phone.length < 7) return res.status(400).json({ error: "invalid_phone" })

  try {
    const row = await one(
      `insert into wa_operators (user_id, phone, label) values ($1,$2,$3)
       on conflict (user_id, phone) do update set label=excluded.label
       returning id, phone, label, created_at`,
      [req.userId, phone, label],
    )
    res.json({ ok: true, operator: row })
  } catch (e) {
    res.status(500).json({ error: "add_failed", detail: e.message })
  }
})

// DELETE /operators/:id — remove one (scoped to this user).
router.delete("/:id", requireAuth, async (req, res) => {
  await query("delete from wa_operators where id=$1 and user_id=$2", [req.params.id, req.userId])
  res.json({ ok: true })
})

module.exports = { operatorsRouter: router, normPhone }
