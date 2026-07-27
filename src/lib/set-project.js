// One-off: set the Jira project_key for any connection missing one.
// Usage (inside container): node src/lib/set-project.js HASH hashtest
require("dotenv").config()
const { pool } = require("./db")
const key = process.argv[2] || "HASH"
const name = process.argv[3] || key
;(async () => {
  const r = await pool.query(
    "update wa_jira_connections set project_key=$1, project_name=$2, updated_at=now() where project_key is null",
    [key, name],
  )
  console.log(`set project_key=${key} for ${r.rowCount} connection(s)`)
  await pool.end()
})().catch((e) => { console.error(e.message); process.exit(1) })
