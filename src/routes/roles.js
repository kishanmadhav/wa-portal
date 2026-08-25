// Space-scoped role management.
//
// The portal user owning the Jira connection is an implicit super admin, so
// every route here is simply gated on requireAuth: if you can log in to the
// portal, you administer your own workspace. The roles stored in the table
// govern what WHATSAPP phone numbers can do, not what portal users can do.
const express = require("express")
const { all, query } = require("../lib/db")
const { requireAuth } = require("./auth")
const { grantRole, normPhone, ROLES } = require("../lib/roles")
const jira = require("../lib/jira")

const router = express.Router()

// GET /roles — every grant for this portal user, newest first.
router.get("/", requireAuth, async (req, res) => {
  try {
    const rows = await all(
      `select id, phone, label, role, space_key, created_at
         from wa_space_roles
        where user_id = $1
        order by
          -- super admins first, then by space, then newest
          case role when 'super_admin' then 0 when 'admin' then 1 else 2 end,
          space_key nulls first,
          created_at desc`,
      [req.userId],
    )
    res.json({ ok: true, roles: rows })
  } catch (e) {
    res.status(500).json({ error: "list_failed", detail: e.message })
  }
})

// GET /roles/spaces — Jira projects available as spaces, for the picker.
router.get("/spaces", requireAuth, async (req, res) => {
  try {
    const projects = await jira.listProjects(req.userId)
    res.json({
      ok: true,
      spaces: (projects || []).map((p) => ({
        key: p.key,
        name: p.name,
      })),
    })
  } catch (e) {
    // Jira unreachable should not break the roles screen — the caller can
    // still type a key manually.
    res.json({ ok: true, spaces: [], warning: "jira_unavailable" })
  }
})

// POST /roles — grant a role.  { phone, label?, role, space_key? }
router.post("/", requireAuth, async (req, res) => {
  const { phone, label, role } = req.body || {}
  const spaceKey = req.body.space_key || req.body.spaceKey || null

  if (!ROLES.includes(role)) {
    return res.status(400).json({ error: "invalid_role", allowed: ROLES })
  }
  if (normPhone(phone).length < 7) {
    return res.status(400).json({ error: "invalid_phone" })
  }

  try {
    const row = await grantRole({
      userId: req.userId,
      phone,
      label,
      role,
      spaceKey,
      grantedBy: req.userId,
    })

    // Keep wa_operators in step. The WhatsApp webhook still uses it as the
    // "is this phone trusted at all" gate, so a phone granted a role here must
    // also appear there or it would be treated as an unknown sender.
    await query(
      `insert into wa_operators (user_id, phone, label)
       values ($1,$2,$3)
       on conflict (user_id, phone) do update set label = coalesce(excluded.label, wa_operators.label)`,
      [req.userId, normPhone(phone), label || null],
    )

    res.json({ ok: true, role: row })
  } catch (e) {
    const known = ["invalid_phone", "invalid_role", "super_admin_is_global", "space_required"]
    if (known.includes(e.message)) return res.status(400).json({ error: e.message })
    res.status(500).json({ error: "grant_failed", detail: e.message })
  }
})

// DELETE /roles/:id — revoke one grant (scoped to this portal user).
router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const rows = await all(
      "delete from wa_space_roles where id=$1 and user_id=$2 returning phone",
      [req.params.id, req.userId],
    )
    const phone = rows[0]?.phone

    // If that was the phone's LAST grant, drop it from wa_operators too —
    // otherwise revoking every role would still leave it trusted by the
    // webhook, which is the opposite of what revoking should mean.
    if (phone) {
      const remaining = await all(
        "select 1 from wa_space_roles where user_id=$1 and phone=$2 limit 1",
        [req.userId, phone],
      )
      if (!remaining.length) {
        await query("delete from wa_operators where user_id=$1 and phone=$2", [
          req.userId,
          phone,
        ])
      }
    }

    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: "revoke_failed", detail: e.message })
  }
})

module.exports = { rolesRouter: router }
