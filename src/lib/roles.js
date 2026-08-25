// Space-scoped role resolution.
//
// A "space" is a Jira project key (HGD, HASH, …) inside the site the portal
// user has connected. Three roles, narrowest first:
//
//   operator     — act on tickets in ONE space
//   admin        — the same, plus manage operators for that ONE space
//   super_admin  — the same, in EVERY space
//
// The portal user who owns the Jira connection is an implicit super admin.
// That is deliberate: it means the role table can never be emptied into a
// state where nobody can administer anything.

const { all, one } = require("./db")

const ROLES = ["operator", "admin", "super_admin"]

// Higher number = more authority. Used for "is at least" comparisons rather
// than scattering role-name checks through the codebase.
const RANK = { operator: 1, admin: 2, super_admin: 3 }

function normPhone(p) {
  return String(p || "").replace(/\D+/g, "")
}

/**
 * Every role row for a phone under one portal user.
 * Returns [] for a phone that has been granted nothing.
 */
async function rolesForPhone(userId, phone) {
  const digits = normPhone(phone)
  if (!digits) return []
  return all(
    `select id, phone, label, role, space_key, created_at
       from wa_space_roles
      where user_id = $1 and phone = $2`,
    [userId, digits],
  )
}

/**
 * The effective role a phone holds in a specific space.
 *
 * A super_admin row has space_key NULL and therefore applies everywhere, so it
 * is checked before any space-specific grant. Returns null when the phone has
 * no role in that space.
 */
async function roleInSpace(userId, phone, spaceKey) {
  const rows = await rolesForPhone(userId, phone)
  if (!rows.length) return null

  if (rows.some((r) => r.role === "super_admin")) return "super_admin"

  const scoped = rows.filter((r) => r.space_key === spaceKey)
  if (!scoped.length) return null

  // A phone could hold several grants in one space through repeated edits;
  // the strongest wins.
  return scoped.reduce(
    (best, r) => (RANK[r.role] > RANK[best] ? r.role : best),
    scoped[0].role,
  )
}

/**
 * Does this phone hold at least `minRole` in this space?
 * The portal owner is short-circuited to true — they own the connection.
 */
async function hasAtLeast(userId, phone, spaceKey, minRole) {
  const role = await roleInSpace(userId, phone, spaceKey)
  if (!role) return false
  return RANK[role] >= RANK[minRole]
}

/**
 * Spaces this phone may act in.
 * `{ all: true }` for a super admin, otherwise an explicit list of keys — so
 * callers can render a space picker without a second query.
 */
async function spacesForPhone(userId, phone) {
  const rows = await rolesForPhone(userId, phone)
  if (rows.some((r) => r.role === "super_admin")) return { all: true, spaces: [] }
  return {
    all: false,
    spaces: [...new Set(rows.map((r) => r.space_key).filter(Boolean))],
  }
}

/**
 * Grant a role. Re-granting the same phone in the same space updates it in
 * place rather than creating a duplicate.
 *
 * Callers MUST have authorised this already — this function does not check
 * whether the granter is allowed to grant.
 */
async function grantRole({ userId, phone, label, email, role, spaceKey, grantedBy }) {
  const digits = normPhone(phone)
  if (digits.length < 7) throw new Error("invalid_phone")
  if (!ROLES.includes(role)) throw new Error("invalid_role")

  // The DB check constraint enforces this too, but failing here gives a clear
  // error instead of a constraint violation surfacing as a 500.
  if (role === "super_admin" && spaceKey) throw new Error("super_admin_is_global")
  if (role !== "super_admin" && !spaceKey) throw new Error("space_required")

  const key = role === "super_admin" ? null : String(spaceKey).trim().toUpperCase()

  // Two partial unique indexes cover this table (scoped vs global), so the
  // conflict target differs by role.
  const conflict =
    role === "super_admin"
      ? "(user_id, phone) where space_key is null"
      : "(user_id, phone, space_key) where space_key is not null"

  return one(
    `insert into wa_space_roles (user_id, phone, label, email, role, space_key, granted_by)
     values ($1,$2,$3,$4,$5,$6,$7)
     on conflict ${conflict}
       do update set role  = excluded.role,
                     label = coalesce(excluded.label, wa_space_roles.label),
                     email = coalesce(excluded.email, wa_space_roles.email)
     returning id, phone, label, email, role, space_key, created_at`,
    [userId, digits, label || null,
     email ? String(email).trim().toLowerCase() : null,
     role, key, grantedBy || null],
  )
}


/**
 * The Jira project keys a phone may act in, ready to pass to jira.searchIssues
 * / countIssues / createTicket.
 *
 * A super admin spans every project on the connected site, so their list is
 * fetched from Jira rather than from the role rows (which store NULL for
 * "all"). Everyone else gets their explicitly granted spaces.
 *
 * Returns [] when the phone has no grants, which callers should treat as
 * "fall back to the connection's pinned project".
 */
async function resolveSpaceKeys(userId, phone, jiraLib) {
  const scope = await spacesForPhone(userId, phone)

  if (!scope.all) return scope.spaces

  try {
    const projects = await jiraLib.listProjects(userId)
    return (projects || []).map((p) => p.key).filter(Boolean)
  } catch (e) {
    // Jira unreachable: fall back to the pinned project rather than failing
    // the whole message.
    console.error("[roles] listProjects failed for super admin:", e.message)
    return []
  }
}

module.exports = {
  ROLES,
  RANK,
  normPhone,
  rolesForPhone,
  roleInSpace,
  hasAtLeast,
  spacesForPhone,
  resolveSpaceKeys,
  grantRole,
}
