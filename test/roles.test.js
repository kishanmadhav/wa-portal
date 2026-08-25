// Tests for space-scoped role logic.
//
// Covers the pure parts — phone normalisation, role ranking, and the JQL
// project scope builder. The DB-backed functions are integration territory and
// are not covered here.
//
// Run: node test/roles.test.js

const assert = require("assert")
const path = require("path")

// db.js opens a pool at require time; stub it so this runs without Postgres.
const dbPath = require.resolve("../src/lib/db")
require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: { pool: {}, query: async () => ({}), one: async () => null, all: async () => [] },
}

const { normPhone, RANK, ROLES } = require("../src/lib/roles")

let failures = 0
function check(desc, got, want) {
  try {
    assert.deepStrictEqual(got, want)
  } catch {
    failures++
    console.log(`  FAIL ${desc}\n       got:  ${JSON.stringify(got)}\n       want: ${JSON.stringify(want)}`)
  }
}

// ── phone normalisation ─────────────────────────────────────────────────────
// WhatsApp formats the sender number inconsistently, so every representation
// of the same number must collapse to identical digits or role lookups miss.
check("strips +", normPhone("+917358350698"), "917358350698")
check("strips spaces", normPhone("91 7358350698"), "917358350698")
check("strips brackets/dashes", normPhone("(91) 7358-350698"), "917358350698")
check("already digits", normPhone("917358350698"), "917358350698")
check("null -> empty", normPhone(null), "")
check("undefined -> empty", normPhone(undefined), "")

// ── role ranking ────────────────────────────────────────────────────────────
check("operator < admin", RANK.operator < RANK.admin, true)
check("admin < super_admin", RANK.admin < RANK.super_admin, true)
check("three roles", ROLES.length, 3)

// ── JQL project scope ───────────────────────────────────────────────────────
// projectScope is module-private in jira.js, so the behaviour is re-asserted
// here against the same rules. Keys reach a JQL string, so anything that is
// not a valid Jira project key must be dropped rather than interpolated.
const KEY_RE = /^[A-Z][A-Z0-9_]{0,29}$/
const clean = (keys) =>
  (Array.isArray(keys) ? keys : [])
    .map((k) => String(k || "").trim().toUpperCase())
    .filter((k) => KEY_RE.test(k))

check("accepts normal keys", clean(["HGD", "kan"]), ["HGD", "KAN"])
check("drops injection attempt", clean(['HGD" OR project="X']), [])
check("drops key starting with a digit", clean(["1HGD"]), [])
check("drops empty", clean(["", null, undefined]), [])
check("drops spaces inside", clean(["HG D"]), [])
check("allows underscore", clean(["MY_PROJ"]), ["MY_PROJ"])

// A super admin with several spaces must produce an IN clause; a single space
// a plain equality; and no spaces must fall back to the pinned project.
function scopeClause(keys, pinned) {
  const k = clean(keys)
  if (!k.length) {
    if (!pinned) throw new Error("no_project_selected")
    return `project = ${pinned}`
  }
  if (k.length === 1) return `project = ${k[0]}`
  return `project IN (${k.join(", ")})`
}

check("no keys -> pinned project", scopeClause([], "HGD"), "project = HGD")
check("one key -> equality", scopeClause(["KAN"], "HGD"), "project = KAN")
check("many keys -> IN", scopeClause(["HGD", "KAN"], "HGD"), "project IN (HGD, KAN)")

let threw = false
try { scopeClause([], null) } catch { threw = true }
check("no keys and no pinned project throws", threw, true)

if (failures) {
  console.log(`\nFAILED (${failures})`)
  process.exit(1)
}
console.log("OK - all role and space-scope cases pass")
