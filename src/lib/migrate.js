// Apply db/schema.sql. Idempotent (everything is CREATE ... IF NOT EXISTS).
// Run with: npm run migrate
require("dotenv").config()
const fs = require("fs")
const path = require("path")
const { pool } = require("./db")

;(async () => {
  const schemaPath = path.join(__dirname, "..", "..", "db", "schema.sql")
  const sql = fs.readFileSync(schemaPath, "utf8")
  console.log("[migrate] applying schema...")
  // Retry briefly — Postgres in Docker may not be ready the instant we start.
  let lastErr
  for (let i = 0; i < 15; i++) {
    try {
      await pool.query(sql)
      console.log("[migrate] schema applied ✓")
      await pool.end()
      process.exit(0)
    } catch (e) {
      lastErr = e
      console.log(`[migrate] db not ready (${e.code || e.message}); retry ${i + 1}/15 in 2s`)
      await new Promise((r) => setTimeout(r, 2000))
    }
  }
  console.error("[migrate] failed:", lastErr?.message)
  process.exit(1)
})()
