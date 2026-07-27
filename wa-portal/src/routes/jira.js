// Jira OAuth connect flow + project selection.
const express = require("express")
const crypto = require("crypto")
const { one, query } = require("../lib/db")
const jira = require("../lib/jira")
const { requireAuth } = require("./auth")

const router = express.Router()

// In-memory state store for the OAuth handshake: state -> userId.
// (Short-lived; a restart mid-flow just means the user clicks Connect again.)
const oauthState = new Map()

// GET /jira/connect — kick off OAuth. Requires an authenticated session.
router.get("/connect", requireAuth, (req, res) => {
  const state = crypto.randomBytes(16).toString("hex")
  oauthState.set(state, req.userId)
  // expire the state after 10 min
  setTimeout(() => oauthState.delete(state), 10 * 60 * 1000).unref?.()
  res.redirect(jira.authorizeUrl(state))
})

// GET /jira/callback — Atlassian redirects here with ?code & ?state.
router.get("/callback", async (req, res) => {
  const { code, state } = req.query
  const userId = oauthState.get(String(state))
  if (!code || !userId) return res.status(400).send("Invalid OAuth state. Please try connecting again.")
  // Bind the state to the session: the user completing the callback MUST be the
  // same user who started the flow. Prevents an attacker from tricking a victim
  // into completing the attacker's OAuth flow (which would overwrite the
  // victim's Jira connection with the attacker's tokens).
  if (!req.session.userId || req.session.userId !== userId) {
    return res.status(403).send("This Jira authorization wasn't started from your session. Please connect again while logged in.")
  }
  oauthState.delete(String(state))

  try {
    const tokens = await jira.exchangeCode(String(code))
    const resources = await jira.accessibleResources(tokens.access_token)
    if (!resources || resources.length === 0) {
      return res.status(400).send("No Jira sites were authorized.")
    }
    const site = resources[0] // take the first granted cloud
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString()

    // Upsert the user's Jira connection.
    await query(
      `insert into wa_jira_connections
         (user_id, cloud_id, site_url, site_name, access_token, refresh_token, expires_at, status)
       values ($1,$2,$3,$4,$5,$6,$7,'active')
       on conflict (user_id) do update set
         cloud_id=excluded.cloud_id, site_url=excluded.site_url, site_name=excluded.site_name,
         access_token=excluded.access_token, refresh_token=excluded.refresh_token,
         expires_at=excluded.expires_at, status='active', updated_at=now()`,
      [userId, site.id, site.url, site.name, tokens.access_token, tokens.refresh_token, expiresAt],
    )

    // Back to the dashboard, where they'll pick a project.
    res.redirect("/dashboard.html?jira=connected")
  } catch (e) {
    console.error("[jira/callback]", e.message)
    res.status(500).send("Failed to connect Jira: " + e.message)
  }
})

// GET /jira/status — is Jira connected? which project?
router.get("/status", requireAuth, async (req, res) => {
  const conn = await one(
    "select cloud_id, site_url, site_name, project_key, project_name, status from wa_jira_connections where user_id=$1",
    [req.userId],
  )
  res.json({ ok: true, connected: !!conn && conn.status === "active", connection: conn || null })
})

// GET /jira/projects — list projects so the user can choose where tickets go.
router.get("/projects", requireAuth, async (req, res) => {
  try {
    const projects = await jira.listProjects(req.userId)
    res.json({ ok: true, projects })
  } catch (e) {
    res.status(502).json({ error: "projects_fetch_failed", detail: e.message })
  }
})

// POST /jira/project — set the chosen project.  { project_key, project_name }
router.post("/project", requireAuth, async (req, res) => {
  const { project_key, project_name } = req.body
  if (!project_key) return res.status(400).json({ error: "project_key_required" })
  await query(
    "update wa_jira_connections set project_key=$1, project_name=$2, updated_at=now() where user_id=$3",
    [project_key, project_name || project_key, req.userId],
  )
  res.json({ ok: true })
})

module.exports = { jiraRouter: router }
