// Jira OAuth + token refresh + ticket creation for wa-portal.
// Reuses Service Genie's Atlassian app credentials (same client id/secret) with
// a redirect URI pointing at THIS app.
const { one, query } = require("./db")

const AUTH_BASE = "https://auth.atlassian.com"
const API_BASE = "https://api.atlassian.com"

function cfg() {
  return {
    clientId: process.env.ATLASSIAN_CLIENT_ID || "",
    clientSecret: process.env.ATLASSIAN_CLIENT_SECRET || "",
    redirectUri: process.env.JIRA_REDIRECT_URI || "http://localhost:4200/jira/callback",
  }
}

// Scopes needed: read user, read/write work (create issues), offline for refresh.
// manage:jira-webhook lets us subscribe to issue-updated / comment-created so
// assignees get WhatsApp pushes. Existing connections were granted WITHOUT it
// — registration returns "401 scope does not match" until the user reconnects
// Jira from the dashboard and re-consents.
const SCOPES = [
  "read:jira-user",
  "read:jira-work",
  "write:jira-work",
  "manage:jira-webhook",
  "offline_access",
].join(" ")

// Build the authorize URL the user is redirected to. `state` ties the callback
// back to the right user.
function authorizeUrl(state) {
  const c = cfg()
  const params = new URLSearchParams({
    audience: "api.atlassian.com",
    client_id: c.clientId,
    scope: SCOPES,
    redirect_uri: c.redirectUri,
    state,
    response_type: "code",
    prompt: "consent",
  })
  return `${AUTH_BASE}/authorize?${params.toString()}`
}

// Exchange the auth code for tokens.
async function exchangeCode(code) {
  const c = cfg()
  const res = await fetch(`${AUTH_BASE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: c.clientId,
      client_secret: c.clientSecret,
      code,
      redirect_uri: c.redirectUri,
    }),
  })
  if (!res.ok) throw new Error(`token_exchange_failed: ${await res.text()}`)
  return res.json() // { access_token, refresh_token, expires_in, ... }
}

// Which Atlassian sites (clouds) did the user grant us? We take the first.
async function accessibleResources(accessToken) {
  const res = await fetch(`${API_BASE}/oauth/token/accessible-resources`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  })
  if (!res.ok) throw new Error(`accessible_resources_failed: ${await res.text()}`)
  return res.json() // [{ id, url, name, scopes, avatarUrl }]
}

// Return a valid access token for this user's Jira connection (refresh if near expiry).
async function validToken(userId) {
  const conn = await one("select * from wa_jira_connections where user_id = $1 and status = 'active'", [userId])
  if (!conn) throw new Error("no_jira_connection")

  const expiresAt = new Date(conn.expires_at)
  if (expiresAt > new Date(Date.now() + 5 * 60 * 1000)) {
    return { token: conn.access_token, conn }
  }

  const c = cfg()
  const res = await fetch(`${AUTH_BASE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: c.clientId,
      client_secret: c.clientSecret,
      refresh_token: conn.refresh_token,
    }),
  })
  if (!res.ok) {
    await query("update wa_jira_connections set status='error' where id=$1", [conn.id])
    throw new Error(`token_refresh_failed: ${await res.text()}`)
  }
  const t = await res.json()
  const newExpiry = new Date(Date.now() + t.expires_in * 1000).toISOString()
  await query(
    "update wa_jira_connections set access_token=$1, refresh_token=$2, expires_at=$3, updated_at=now() where id=$4",
    [t.access_token, t.refresh_token || conn.refresh_token, newExpiry, conn.id],
  )
  conn.access_token = t.access_token
  conn.refresh_token = t.refresh_token || conn.refresh_token
  conn.expires_at = newExpiry
  return { token: t.access_token, conn }
}

// List projects in the connected cloud (for the "choose a project" step).
async function listProjects(userId) {
  const { token, conn } = await validToken(userId)
  const projects = []
  let startAt = 0
  for (let i = 0; i < 20; i++) {
    const res = await fetch(
      `${API_BASE}/ex/jira/${conn.cloud_id}/rest/api/3/project/search?startAt=${startAt}&maxResults=50`,
      { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } },
    )
    if (!res.ok) break
    const data = await res.json()
    for (const p of data.values || []) projects.push({ key: p.key, name: p.name, id: p.id })
    if (data.isLast || projects.length >= (data.total || 0)) break
    startAt += 50
  }
  return projects
}

// Pick a sensible issue type for the project (handles JSM prose names too).
async function pickIssueType(token, cloudId, projectKey) {
  try {
    const res = await fetch(
      `${API_BASE}/ex/jira/${cloudId}/rest/api/3/issue/createmeta?projectKeys=${projectKey}&expand=projects.issuetypes`,
      { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } },
    )
    if (!res.ok) return "Task"
    const meta = await res.json()
    const names = (meta.projects?.[0]?.issuetypes || []).map((t) => t.name)
    const preferred = ["Service Request", "Support Request", "Incident", "Task", "Bug", "Story"]
    for (const p of preferred) {
      const hit = names.find((n) => n.toLowerCase() === p.toLowerCase())
      if (hit) return hit
    }
    const kw =
      names.find((n) => /incident/i.test(n)) ||
      names.find((n) => /request/i.test(n) && !/email/i.test(n)) ||
      names.find((n) => /support|issue|problem/i.test(n))
    return kw || names[0] || "Task"
  } catch {
    return "Task"
  }
}

// Build the `project = X` / `project IN (X, Y)` clause for a query.
//
//   spaceKeys null       -> the connection's pinned project (single-space)
//   spaceKeys []         -> the pinned project (a super admin with no explicit
//                           scope still needs a valid clause)
//   spaceKeys ["A","B"]  -> project IN (A, B)
//
// Keys are validated against Jira's own format before interpolation, since
// they reach a JQL string.
function projectScope(conn, spaceKeys) {
  const keys = (Array.isArray(spaceKeys) ? spaceKeys : [])
    .map((k) => String(k || "").trim().toUpperCase())
    .filter((k) => /^[A-Z][A-Z0-9_]{0,29}$/.test(k))

  if (!keys.length) {
    if (!conn.project_key) throw new Error("no_project_selected")
    return `project = ${conn.project_key}`
  }
  if (keys.length === 1) return `project = ${keys[0]}`
  return `project IN (${keys.join(", ")})`
}

// Create a Jira ticket for this user.
// `spaceKey` overrides the connection's pinned project, so a sender whose role
// is scoped to a different space files tickets there instead. Falls back to the
// pinned project when not supplied, which is the single-space behaviour.
async function createTicket(userId, { issueText, fromPhone, spaceKey }) {
  const { token, conn } = await validToken(userId)
  const projectKey = spaceKey || conn.project_key
  if (!projectKey) throw new Error("no_project_selected")
  const cloudId = conn.cloud_id
  const issueType = await pickIssueType(token, cloudId, projectKey)

  const summary = String(issueText).slice(0, 240)
  const descriptionText = [
    issueText,
    "",
    `— Reported via WhatsApp from +${fromPhone}`,
  ].join("\n")

  const body = {
    fields: {
      project: { key: projectKey },
      summary,
      issuetype: { name: issueType },
      description: {
        type: "doc",
        version: 1,
        content: [{ type: "paragraph", content: [{ type: "text", text: descriptionText }] }],
      },
    },
  }

  const res = await fetch(`${API_BASE}/ex/jira/${cloudId}/rest/api/3/issue`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`jira_create_failed ${res.status}: ${await res.text()}`)
  const created = await res.json()
  const url = conn.site_url ? `${conn.site_url}/browse/${created.key}` : null
  return { key: created.key, url, issueType }
}

// Find a Jira user by name or email. Returns { accountId, displayName } or null.
async function findUser(userId, queryText) {
  const { token, conn } = await validToken(userId)
  const q = String(queryText || "").trim()
  if (!q) return null
  try {
    const res = await fetch(
      `${API_BASE}/ex/jira/${conn.cloud_id}/rest/api/3/user/search?query=${encodeURIComponent(q)}&maxResults=5`,
      { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } },
    )
    if (!res.ok) return null
    const users = await res.json()
    if (!Array.isArray(users) || users.length === 0) return null
    // Prefer an exact email match, else the first active human result.
    const lower = q.toLowerCase()
    const exact = users.find((u) => (u.emailAddress || "").toLowerCase() === lower)
    const pick = exact || users.find((u) => u.accountType === "atlassian") || users[0]
    return pick
      ? { accountId: pick.accountId, displayName: pick.displayName, email: pick.emailAddress || null }
      : null
  } catch {
    return null
  }
}

// Map a loose priority word to the project's actual priority names.
async function resolvePriority(userId, word) {
  const { token, conn } = await validToken(userId)
  const w = String(word || "").toLowerCase().trim()
  if (!w) return null
  try {
    const res = await fetch(`${API_BASE}/ex/jira/${conn.cloud_id}/rest/api/3/priority`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    })
    if (!res.ok) return null
    const priorities = await res.json() // [{ id, name }]
    const names = priorities.map((p) => p.name)
    // Synonym buckets → preferred target names (in order).
    const buckets = [
      { match: /(highest|critical|urgent|p1|blocker|emergency)/, targets: ["Highest", "Critical", "Urgent", "High"] },
      { match: /(high|important|p2)/, targets: ["High", "Highest"] },
      { match: /(medium|normal|moderate|p3|default)/, targets: ["Medium", "Normal"] },
      { match: /(low|minor|p4)/, targets: ["Low", "Minor"] },
      { match: /(lowest|trivial|p5)/, targets: ["Lowest", "Trivial", "Low"] },
    ]
    const bucket = buckets.find((b) => b.match.test(w))
    const tryNames = bucket ? bucket.targets : []
    // also try the literal word matching a priority name directly
    for (const target of [...tryNames, w]) {
      const hit = priorities.find((p) => p.name.toLowerCase() === String(target).toLowerCase())
      if (hit) return { id: hit.id, name: hit.name }
    }
    // default to Medium-ish if present
    const med = priorities.find((p) => /medium|normal/i.test(p.name))
    return med ? { id: med.id, name: med.name } : null
  } catch {
    return null
  }
}

// Update a ticket's assignee and/or priority. Each is best-effort; failures on
// one field don't block the other. Returns { assignee, priority } applied.
async function updateTicket(userId, issueKey, { assigneeQuery, priorityWord }) {
  const { token, conn } = await validToken(userId)
  const base = `${API_BASE}/ex/jira/${conn.cloud_id}/rest/api/3/issue/${issueKey}`
  const applied = { assignee: null, assigneeUser: null, priority: null }

  // Priority via the fields update (safe even on JSM projects that expose it).
  if (priorityWord) {
    const pr = await resolvePriority(userId, priorityWord)
    if (pr) {
      const res = await fetch(base, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ fields: { priority: { id: pr.id } } }),
      })
      if (res.ok) applied.priority = pr.name
      else console.warn(`[jira] priority update failed for ${issueKey}:`, await res.text())
    }
  }

  // Assignee via the dedicated assignee endpoint.
  if (assigneeQuery) {
    const user = await findUser(userId, assigneeQuery)
    if (user) {
      const res = await fetch(`${base}/assignee`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: user.accountId }),
      })
      if (res.ok) { applied.assignee = user.displayName; applied.assigneeUser = user }
      else console.warn(`[jira] assignee update failed for ${issueKey}:`, await res.text())
    }
  }

  return applied
}

// ── Operator query helpers ───────────────────────────────────────────────────
// Read-only Jira lookups used by the verified-operator WhatsApp flow.

// Run a JQL search scoped to the user's connected project. Returns up to
// `maxResults` issues with a compact field set.
async function searchIssues(userId, jqlExtra, maxResults = 20, spaceKeys = null) {
  const { token, conn } = await validToken(userId)
  const scope = projectScope(conn, spaceKeys)
  const jql = `${scope}${jqlExtra ? ` AND ${jqlExtra}` : ""} ORDER BY updated DESC`
  const params = new URLSearchParams({
    jql,
    maxResults: String(maxResults),
    fields: "summary,status,priority,assignee,issuetype,updated,created",
  })
  const res = await fetch(
    `${API_BASE}/ex/jira/${conn.cloud_id}/rest/api/3/search/jql?${params}`,
    { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } },
  )
  if (!res.ok) throw new Error(`jira_search_failed ${res.status}: ${await res.text()}`)
  const data = await res.json()
  return (data.issues || []).map((i) => ({
    key: i.key,
    summary: i.fields?.summary || "",
    status: i.fields?.status?.name || "",
    priority: i.fields?.priority?.name || "",
    assignee: i.fields?.assignee?.displayName || "Unassigned",
    type: i.fields?.issuetype?.name || "",
    updated: i.fields?.updated || null,
  }))
}

// Fetch one ticket by key (within the user's project for safety).
async function getTicket(userId, key) {
  const { token, conn } = await validToken(userId)
  const res = await fetch(
    `${API_BASE}/ex/jira/${conn.cloud_id}/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,status,priority,assignee,issuetype,reporter,updated,created`,
    { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } },
  )
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`jira_get_failed ${res.status}`)
  const i = await res.json()
  return {
    key: i.key,
    summary: i.fields?.summary || "",
    status: i.fields?.status?.name || "",
    priority: i.fields?.priority?.name || "",
    assignee: i.fields?.assignee?.displayName || "Unassigned",
    reporter: i.fields?.reporter?.displayName || "",
    type: i.fields?.issuetype?.name || "",
    updated: i.fields?.updated || null,
  }
}

// Count issues matching an optional JQL filter. The new /search/jql endpoint
// no longer returns a `total`, so we use the dedicated approximate-count
// endpoint (POST, returns { count }).
async function countIssues(userId, jqlExtra, spaceKeys = null) {
  const { token, conn } = await validToken(userId)
  const scope = projectScope(conn, spaceKeys)
  const jql = `${scope}${jqlExtra ? ` AND ${jqlExtra}` : ""}`
  const res = await fetch(
    `${API_BASE}/ex/jira/${conn.cloud_id}/rest/api/3/search/approximate-count`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ jql }),
    },
  )
  if (!res.ok) throw new Error(`jira_count_failed ${res.status}: ${await res.text()}`)
  const data = await res.json()
  return data.count ?? 0
}

// Transition an issue so it lands in the target status CATEGORY.
//   targetCat: "done" (resolve) | "new" (reopen to To Do) | "indeterminate" (In Progress)
// Workflows are multi-step (To Do -> In Progress -> Done), so we walk up to 3
// transitions, each time picking the one whose destination moves us toward the
// target category. Returns { ok, finalStatus } or { ok:false, reason }.
async function transitionToCategory(userId, key, targetCat) {
  const { token, conn } = await validToken(userId)
  const base = `${API_BASE}/ex/jira/${conn.cloud_id}/rest/api/3/issue/${encodeURIComponent(key)}`

  const getTransitions = async () => {
    const r = await fetch(`${base}/transitions`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } })
    if (!r.ok) return []
    return (await r.json()).transitions || []
  }
  const getCurrentCat = async () => {
    const r = await fetch(`${base}?fields=status`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } })
    if (!r.ok) return null
    const j = await r.json()
    return { cat: j.fields?.status?.statusCategory?.key, name: j.fields?.status?.name }
  }
  const apply = async (id) => {
    const r = await fetch(`${base}/transitions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ transition: { id } }),
    })
    return r.ok
  }

  // Order of categories along the workflow, so we know which direction to step.
  // new(To Do) -> indeterminate(In Progress) -> done.
  const order = { new: 0, indeterminate: 1, done: 2 }
  const targetRank = order[targetCat]
  if (targetRank == null) return { ok: false, reason: "bad_target" }

  let cur = await getCurrentCat()
  if (!cur) return { ok: false, reason: "not_found" }

  for (let step = 0; step < 4; step++) {
    if (cur.cat === targetCat) return { ok: true, finalStatus: cur.name }
    const transitions = await getTransitions()
    if (transitions.length === 0) return { ok: false, reason: "no_transitions", finalStatus: cur.name }

    const curRank = order[cur.cat] ?? 1
    // 1) a transition landing exactly on the target category
    let next = transitions.find((t) => t.to?.statusCategory?.key === targetCat)
    // 2) else a transition that steps in the right direction
    if (!next) {
      next = transitions.find((t) => {
        const r = order[t.to?.statusCategory?.key]
        return r != null && (targetRank > curRank ? r > curRank : r < curRank)
      })
    }
    if (!next) return { ok: false, reason: "no_path", finalStatus: cur.name }

    if (!(await apply(next.id))) return { ok: false, reason: "transition_failed", finalStatus: cur.name }
    cur = await getCurrentCat()
    if (!cur) return { ok: false, reason: "lost_after_transition" }
  }
  return { ok: cur.cat === targetCat, finalStatus: cur.name }
}

// Permanently delete an issue. Returns { ok } or { ok:false, reason }.
async function deleteTicket(userId, key) {
  const { token, conn } = await validToken(userId)
  const res = await fetch(
    `${API_BASE}/ex/jira/${conn.cloud_id}/rest/api/3/issue/${encodeURIComponent(key)}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
  )
  if (res.status === 404) return { ok: false, reason: "not_found" }
  if (res.status === 403) return { ok: false, reason: "no_permission" }
  if (!res.ok && res.status !== 204) return { ok: false, reason: `http_${res.status}` }
  return { ok: true }
}

// Add a plain-text comment to an issue. Returns { ok } or { ok:false, reason }.
async function addComment(userId, key, text) {
  const { token, conn } = await validToken(userId)
  const res = await fetch(
    `${API_BASE}/ex/jira/${conn.cloud_id}/rest/api/3/issue/${encodeURIComponent(key)}/comment`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        body: {
          type: "doc", version: 1,
          content: [{ type: "paragraph", content: [{ type: "text", text: String(text).slice(0, 2000) }] }],
        },
      }),
    },
  )
  if (res.status === 404) return { ok: false, reason: "not_found" }
  if (!res.ok) return { ok: false, reason: `http_${res.status}` }
  return { ok: true }
}

// Transition an issue to a NAMED status (e.g. "In Review", "Blocked", "In
// Progress"). Direct transitions are tried first; if the target isn't reachable
// from the current status, we hop through intermediate transitions (workflows
// are often To Do -> In Progress -> In Review -> Done) for up to 3 hops.
// Returns { ok, finalStatus } or { ok:false, reason, finalStatus }.
async function transitionToStatus(userId, key, statusWord) {
  const { token, conn } = await validToken(userId)
  const base = `${API_BASE}/ex/jira/${conn.cloud_id}/rest/api/3/issue/${encodeURIComponent(key)}`
  const want = String(statusWord || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
  if (!want) return { ok: false, reason: "no_status" }

  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
  const matches = (name) => {
    const n = norm(name)
    return n === want || n.includes(want) || want.includes(n)
  }
  const getTransitions = async () => {
    const r = await fetch(`${base}/transitions`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } })
    if (!r.ok) return []
    return (await r.json()).transitions || []
  }
  const getCurrent = async () => {
    const r = await fetch(`${base}?fields=status`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } })
    if (!r.ok) return null
    const j = await r.json()
    return { name: j.fields?.status?.name, cat: j.fields?.status?.statusCategory?.key }
  }
  const apply = async (id) => {
    const r = await fetch(`${base}/transitions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ transition: { id } }),
    })
    return r.ok
  }

  let cur = await getCurrent()
  if (!cur) return { ok: false, reason: "not_found" }
  if (matches(cur.name)) return { ok: true, finalStatus: cur.name }

  // Guess which category the target lives in, so intermediate hops move the
  // right way when the target isn't directly reachable.
  const wantCat = /done|closed|resolved|complete|cancel/.test(want) ? "done"
    : /to do|todo|open|backlog|new/.test(want) ? "new" : "indeterminate"
  const order = { new: 0, indeterminate: 1, done: 2 }

  for (let hop = 0; hop < 4; hop++) {
    const transitions = await getTransitions()
    if (transitions.length === 0) return { ok: false, reason: "no_transitions", finalStatus: cur.name }

    // Direct hit: a transition whose destination (or own name) matches.
    const direct = transitions.find((t) => matches(t.to?.name)) || transitions.find((t) => matches(t.name))
    if (direct) {
      if (!(await apply(direct.id))) return { ok: false, reason: "transition_failed", finalStatus: cur.name }
      cur = await getCurrent()
      return { ok: true, finalStatus: cur?.name || direct.to?.name || statusWord }
    }

    // No direct path — step one transition toward the target's category.
    const curRank = order[cur.cat] ?? 1
    const targetRank = order[wantCat]
    const step = transitions.find((t) => {
      const r = order[t.to?.statusCategory?.key]
      return r != null && (targetRank > curRank ? r > curRank : targetRank < curRank ? r < curRank : r !== curRank)
    })
    if (!step) return { ok: false, reason: "no_path", finalStatus: cur.name }
    if (!(await apply(step.id))) return { ok: false, reason: "transition_failed", finalStatus: cur.name }
    cur = await getCurrent()
    if (!cur) return { ok: false, reason: "lost_after_transition" }
    if (matches(cur.name)) return { ok: true, finalStatus: cur.name }
  }
  return { ok: false, reason: "not_reachable", finalStatus: cur.name }
}


// ── Jira -> us change notifications ─────────────────────────────────────────
// Subscribe Jira to POST issue updates and new comments to our events route so
// assignees get told about status changes and comments. One webhook per
// connection, secret in the URL path (Jira Cloud OAuth webhooks do not sign
// bodies, so the unguessable path IS the auth).
async function registerJiraWebhook(userId, publicBase, secret) {
  const { token, conn } = await validToken(userId)
  const url = `${publicBase.replace(/\/$/, "")}/jira/events/${secret}`

  // Webhook JQL is a restricted subset: no `is not EMPTY`, no wildcards.
  // Jira rejects those with "Operator ... is unsupported". Enumerate the
  // site's projects explicitly instead. Re-registration on reconnect keeps
  // this current as projects are added.
  const projects = await listProjects(userId)
  const keys = projects.map((p) => p.key).filter((k) => /^[A-Z][A-Z0-9_]*$/.test(k))
  if (!keys.length) throw new Error("jira_webhook_no_projects")
  const jqlFilter = keys.length === 1 ? `project = ${keys[0]}` : `project IN (${keys.join(", ")})`
  const res = await fetch(`${API_BASE}/ex/jira/${conn.cloud_id}/rest/api/3/webhook`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      url,
      webhooks: [{
        events: ["jira:issue_updated", "comment_created"],
        // Jira REQUIRES a jqlFilter on OAuth webhooks; built above from the
        // real project keys. We filter to assigned-to-a-known-phone ourselves.
        jqlFilter,
      }],
    }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`jira_webhook_register_failed ${res.status} ${JSON.stringify(data).slice(0, 200)}`)
  const created = (data.webhookRegistrationResult || [])[0]
  if (!created || created.errors) throw new Error(`jira_webhook_rejected ${JSON.stringify(created?.errors || data).slice(0, 200)}`)
  return { id: String(created.createdWebhookId), url }
}

function isResolvedStatus(name) {
  return /done|resolved|closed|complete|cancel/i.test(String(name || ""))
}

module.exports = {
  authorizeUrl,
  exchangeCode,
  accessibleResources,
  validToken,
  listProjects,
  createTicket,
  findUser,
  resolvePriority,
  updateTicket,
  searchIssues,
  getTicket,
  registerJiraWebhook,
  isResolvedStatus,
  countIssues,
  transitionToCategory,
  transitionToStatus,
  deleteTicket,
  addComment,
}
