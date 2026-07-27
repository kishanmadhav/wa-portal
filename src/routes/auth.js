// Signup / login / logout. Email + bcrypt password, session cookie.
const express = require("express")
const bcrypt = require("bcryptjs")
const rateLimit = require("express-rate-limit")
const { one } = require("../lib/db")

const router = express.Router()

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const BCRYPT_ROUNDS = 12

// Brute-force protection: 10 auth attempts per IP per 15 minutes.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too_many_attempts", detail: "Try again in a few minutes." },
})

// POST /auth/signup  { email, password, display_name? }
router.post("/signup", authLimiter, async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase()
    const password = String(req.body.password || "")
    const displayName = String(req.body.display_name || "").trim() || null

    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "invalid_email" })
    if (password.length < 8) return res.status(400).json({ error: "password_too_short", detail: "min 8 chars" })

    const existing = await one("select id from wa_users where email = $1", [email])
    if (existing) return res.status(409).json({ error: "email_taken" })

    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS)
    const user = await one(
      "insert into wa_users (email, password_hash, display_name) values ($1,$2,$3) returning id, email, display_name",
      [email, hash, displayName],
    )

    req.session.userId = user.id
    res.json({ ok: true, user })
  } catch (e) {
    console.error("[auth/signup]", e.message)
    res.status(500).json({ error: "signup_failed" })
  }
})

// POST /auth/login  { email, password }
router.post("/login", authLimiter, async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase()
    const password = String(req.body.password || "")

    const user = await one("select id, email, password_hash, display_name from wa_users where email = $1", [email])
    if (!user) return res.status(401).json({ error: "invalid_credentials" })

    const ok = await bcrypt.compare(password, user.password_hash)
    if (!ok) return res.status(401).json({ error: "invalid_credentials" })

    req.session.userId = user.id
    res.json({ ok: true, user: { id: user.id, email: user.email, display_name: user.display_name } })
  } catch (e) {
    console.error("[auth/login]", e.message)
    res.status(500).json({ error: "login_failed" })
  }
})

// POST /auth/logout
router.post("/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }))
})

// GET /auth/me — current user (used by the dashboard to check session)
router.get("/me", async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: "not_authenticated" })
  const user = await one("select id, email, display_name from wa_users where id = $1", [req.session.userId])
  if (!user) return res.status(401).json({ error: "not_authenticated" })
  res.json({ ok: true, user })
})

// Middleware: require an authenticated session.
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: "not_authenticated" })
  req.userId = req.session.userId
  next()
}

module.exports = { authRouter: router, requireAuth }
