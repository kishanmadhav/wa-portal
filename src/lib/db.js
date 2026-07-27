// Postgres connection pool + tiny query helpers.
const { Pool } = require("pg")

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Allow a few connections; this is a small app.
  max: 10,
  idleTimeoutMillis: 30000,
})

pool.on("error", (err) => {
  console.error("[db] unexpected pool error:", err.message)
})

async function query(text, params) {
  return pool.query(text, params)
}

// Return the first row or null.
async function one(text, params) {
  const { rows } = await pool.query(text, params)
  return rows[0] || null
}

// Return all rows.
async function all(text, params) {
  const { rows } = await pool.query(text, params)
  return rows
}

module.exports = { pool, query, one, all }
