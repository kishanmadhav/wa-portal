-- wa-portal schema. All tables prefixed wa_ so they can coexist with anything
-- else in the same Postgres instance.

create extension if not exists "pgcrypto";  -- for gen_random_uuid()

-- ── Users ────────────────────────────────────────────────────────────────────
create table if not exists wa_users (
  id             uuid primary key default gen_random_uuid(),
  email          text not null unique,
  password_hash  text not null,
  display_name   text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- ── Jira connection (one per user) ───────────────────────────────────────────
-- Stores the OAuth tokens + the chosen cloud + project to file tickets into.
create table if not exists wa_jira_connections (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references wa_users(id) on delete cascade,
  cloud_id         text not null,
  site_url         text,
  site_name        text,
  access_token     text not null,
  refresh_token    text not null,
  expires_at       timestamptz not null,
  project_key      text,             -- chosen project to create tickets in
  project_name     text,
  status           text not null default 'active',  -- active | error | revoked
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (user_id)                   -- one Jira connection per user
);

-- ── WhatsApp session (one per user) ──────────────────────────────────────────
-- Mirrors the OpenWA session so we know which OpenWA session belongs to whom.
create table if not exists wa_sessions (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references wa_users(id) on delete cascade,
  openwa_session_id  text,            -- the id OpenWA assigns (legacy)
  phone              text,            -- linked WhatsApp number (once connected)
  push_name          text,
  status             text not null default 'created',  -- created|qr_ready|ready|disconnected
  webhook_id         text,            -- the OpenWA webhook id we attached (legacy)
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (user_id),                   -- one session per user (for now)
  unique (openwa_session_id)
);

-- ── Meta WhatsApp Cloud API columns ──────────────────────────────────────────
-- Added for the Cloud API migration. Each tenant's number is identified by its
-- phone_number_id + waba_id, authorised by a per-tenant access token (from
-- Embedded Signup). These are nullable so the OpenWA rows remain valid during
-- the transition. The token is a live credential — treat this column as secret.
alter table wa_sessions add column if not exists phone_number_id text;
alter table wa_sessions add column if not exists waba_id         text;
alter table wa_sessions add column if not exists access_token    text;
alter table wa_sessions add column if not exists provider        text default 'openwa';  -- openwa | cloud
alter table wa_sessions add column if not exists verified_name   text;   -- the WABA display name Meta approved
create unique index if not exists idx_wa_sessions_phone_number_id
  on wa_sessions(phone_number_id) where phone_number_id is not null;

-- ── Conversation state (per sender, per user) ────────────────────────────────
-- Tracks where each WhatsApp sender is in the support flow.
create table if not exists wa_conversations (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references wa_users(id) on delete cascade,
  sender_chat_id text not null,       -- "<phone>@c.us" or "<lid>@lid"
  sender_phone   text,                -- resolved real phone
  step           text not null default 'idle',  -- idle | awaiting_issue | awaiting_assist
  last_ticket_key text,               -- the ticket created this cycle (for follow-up updates)
  updated_at     timestamptz not null default now(),
  unique (user_id, sender_chat_id)
);

-- (migration for existing deployments)
alter table wa_conversations add column if not exists last_ticket_key text;

-- ── Tickets created (audit + dashboard) ──────────────────────────────────────
create table if not exists wa_tickets (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references wa_users(id) on delete cascade,
  jira_key       text not null,       -- e.g. "HGD-123"
  jira_url       text,
  sender_phone   text,
  issue_text     text,
  created_at     timestamptz not null default now()
);

-- ── Verified operators ───────────────────────────────────────────────────────
-- Phone numbers a portal user trusts to QUERY their Jira workspace over
-- WhatsApp (ticket status, priority, counts, recent activity). Stored digits-
-- only (no +, spaces) so matching is robust regardless of how WhatsApp formats
-- the sender number.
create table if not exists wa_operators (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references wa_users(id) on delete cascade,
  phone       text not null,            -- digits only, e.g. "917358350698"
  label       text,                     -- optional friendly name
  created_at  timestamptz not null default now(),
  unique (user_id, phone)
);

-- ── Scheduled reminders (operator-only) ──────────────────────────────────────
-- A future WhatsApp message to send to an operator. Two kinds:
--   "deadline" — auto-created from a ticket deadline (12h before / 1h before /
--                at the deadline), references the ticket.
--   "task"     — a standalone "remind me to X by Y" reminder.
-- fire_at is stored in UTC. The reminder worker polls for rows whose fire_at
-- has passed and sent=false, sends the message, and marks them sent.
create table if not exists wa_reminders (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references wa_users(id) on delete cascade,
  openwa_session_id text not null,        -- which WhatsApp session sends it
  chat_id           text not null,        -- operator's WhatsApp chat id
  operator_phone    text,
  kind              text not null,        -- deadline | task
  message           text not null,        -- the reminder text to send
  ticket_key        text,                 -- for deadline reminders
  fire_at           timestamptz not null, -- when to send (UTC)
  sent              boolean not null default false,
  sent_at           timestamptz,
  created_at        timestamptz not null default now()
);

create index if not exists idx_wa_sessions_user on wa_sessions(user_id);
create index if not exists idx_wa_sessions_openwa on wa_sessions(openwa_session_id);
create index if not exists idx_wa_jira_user on wa_jira_connections(user_id);
create index if not exists idx_wa_conv_user_sender on wa_conversations(user_id, sender_chat_id);
create index if not exists idx_wa_tickets_user on wa_tickets(user_id, created_at desc);
create index if not exists idx_wa_operators_user on wa_operators(user_id);
create index if not exists idx_wa_operators_phone on wa_operators(phone);
create index if not exists idx_wa_reminders_due on wa_reminders(sent, fire_at);
