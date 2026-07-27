require("dotenv").config()
const path = require("path")
const express = require("express")
const session = require("express-session")
const cookieParser = require("cookie-parser")

const { authRouter, requireAuth } = require("./routes/auth")
const { jiraRouter } = require("./routes/jira")
const { whatsappRouter } = require("./routes/whatsapp")
const { webhookRouter } = require("./routes/webhook")
const { cloudWebhookRouter } = require("./routes/webhook-cloud")
const { operatorsRouter } = require("./routes/operators")
const { remindersRouter } = require("./routes/reminders")
const { all } = require("./lib/db")

const app = express()
const PORT = Number(process.env.PORT || 4200)
const IS_PROD = process.env.NODE_ENV === "production"
const WA_PROVIDER = (process.env.WHATSAPP_PROVIDER || "openwa").toLowerCase()

// ── Fail-fast config guards ──────────────────────────────────────────────────
// In production, refuse to boot with insecure default secrets. This prevents an
// accidental deploy that signs sessions with a public string or authenticates
// the webhook with no secret at all.
function requireSecret(name, { minLen = 16 } = {}) {
  const v = process.env[name] || ""
  if (IS_PROD && (v.length < minLen || /change-me|dev-/.test(v))) {
    console.error(`[wa-portal] FATAL: ${name} must be set to a strong value in production.`)
    process.exit(1)
  }
}
requireSecret("SESSION_SECRET", { minLen: 24 })
requireSecret("WEBHOOK_SECRET", { minLen: 16 })
if (WA_PROVIDER === "openwa") requireSecret("OPENWA_API_KEY", { minLen: 8 })
if (WA_PROVIDER === "cloud") {
  requireSecret("META_ACCESS_TOKEN", { minLen: 20 })
  requireSecret("META_WEBHOOK_VERIFY_TOKEN", { minLen: 8 })
  // META_APP_SECRET is checked at request time (webhook refuses unsigned in prod).
}

// Behind a reverse proxy (Caddy/nginx/ALB) so secure cookies + req.protocol work.
app.set("trust proxy", 1)

// ── Meta Cloud webhook ───────────────────────────────────────────────────────
// Mounted BEFORE the global json parser, with its own parser that captures the
// raw body so we can verify Meta's X-Hub-Signature-256 over the exact bytes.
app.use(
  "/whatsapp/cloud",
  express.json({
    limit: "1mb",
    verify: (req, _res, buf) => { req.rawBody = buf },
  }),
  cloudWebhookRouter,
) // exposes GET/POST /whatsapp/cloud/webhook

// Legacy OpenWA webhook — its own body parser (large payloads), mounted BEFORE
// the global json parser so its 100mb limit applies.
app.use("/whatsapp", webhookRouter) // exposes POST /whatsapp/webhook/<secret>

app.use(express.json({ limit: "1mb" }))
app.use(cookieParser())
app.use(
  session({
    secret: process.env.SESSION_SECRET || "dev-insecure-secret-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      // secure cookies in production (served over HTTPS via the reverse proxy).
      secure: IS_PROD,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  }),
)

app.get("/healthz", (_req, res) => res.json({ ok: true }))

// API routes
app.use("/auth", authRouter)
app.use("/jira", jiraRouter)
app.use("/whatsapp", whatsappRouter) // connect/qr/status/disconnect
app.use("/operators", operatorsRouter) // verified-operator management
app.use("/reminders", remindersRouter) // reminder delivery (secret-protected)

// Recent tickets for the dashboard.
app.get("/tickets", requireAuth, async (req, res) => {
  const rows = await all(
    "select jira_key, jira_url, sender_phone, issue_text, created_at from wa_tickets where user_id=$1 order by created_at desc limit 25",
    [req.userId],
  )
  res.json({ ok: true, tickets: rows })
})

// Static dashboard pages.
app.use(express.static(path.join(__dirname, "..", "public")))
app.get("/", (_req, res) => res.redirect("/login.html"))

app.listen(PORT, () => {
  console.log(`[wa-portal] listening on http://localhost:${PORT}`)
  console.log(`[wa-portal] WhatsApp provider: ${WA_PROVIDER}`)
  if (WA_PROVIDER === "cloud") {
    console.log(`[wa-portal] Meta Graph: ${process.env.META_GRAPH_VERSION || "v21.0"} · phone_id=${process.env.META_PHONE_NUMBER_ID || "(per-tenant)"} · token=${process.env.META_ACCESS_TOKEN ? "set" : "MISSING"}`)
  } else {
    console.log(`[wa-portal] OpenWA: ${process.env.OPENWA_URL || "http://localhost:2785"}`)
  }
  console.log(`[wa-portal] OpenAI: ${process.env.OPENAI_API_KEY ? (process.env.OPENAI_MODEL || "gpt-4o-mini") : "DISABLED"}`)
})
