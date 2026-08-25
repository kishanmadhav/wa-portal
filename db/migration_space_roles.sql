-- ═══════════════════════════════════════════════════════════════════════════
-- Space-scoped roles for WhatsApp users
--
-- Before this, wa_operators was a flat list: a phone was either trusted for
-- the portal user's one pinned Jira project, or it was not. This introduces
-- three roles, scoped to a Jira project ("space"):
--
--   operator     — query / create / comment / transition tickets in ONE space
--   admin        — everything an operator can, plus add and remove operators
--                  for that ONE space
--   super_admin  — the same, across EVERY space
--
-- The portal user who owns the Jira connection is implicitly super admin and
-- is not stored here, so the list can never be emptied into a lockout.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists wa_space_roles (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references wa_users(id) on delete cascade,

  phone       text not null,            -- digits only, matching wa_operators
  label       text,                     -- optional friendly name

  role        text not null check (role in ('operator', 'admin', 'super_admin')),

  -- Which Jira project this role applies to, e.g. 'HGD'.
  -- NULL means "all spaces" and is only valid for super_admin — enforced by
  -- the check below, so an operator can never accidentally become global.
  space_key   text,

  granted_by  uuid references wa_users(id) on delete set null,
  created_at  timestamptz not null default now(),

  constraint wa_space_roles_scope_ck check (
    (role = 'super_admin' and space_key is null) or
    (role in ('operator', 'admin') and space_key is not null)
  )
);

-- A phone holds at most one role per space. Postgres treats NULLs as distinct
-- in a normal unique constraint, so super_admin rows (space_key IS NULL) need
-- a separate partial index or the same phone could be added repeatedly.
create unique index if not exists uq_wa_space_roles_scoped
  on wa_space_roles (user_id, phone, space_key)
  where space_key is not null;

create unique index if not exists uq_wa_space_roles_global
  on wa_space_roles (user_id, phone)
  where space_key is null;

create index if not exists idx_wa_space_roles_user  on wa_space_roles(user_id);
create index if not exists idx_wa_space_roles_phone on wa_space_roles(user_id, phone);

-- ── Backfill ───────────────────────────────────────────────────────────────
-- Existing verified operators keep working: each becomes an operator of the
-- project their portal user already had pinned. Without this they would lose
-- access the moment role checks go live.
insert into wa_space_roles (user_id, phone, label, role, space_key)
select o.user_id, o.phone, o.label, 'operator', c.project_key
from wa_operators o
join wa_jira_connections c on c.user_id = o.user_id
where c.project_key is not null
on conflict do nothing;

-- wa_operators is intentionally left in place. It is still the source of
-- truth for "is this phone trusted at all", and dropping it would break the
-- webhook lookup before the new checks are proven in production.
comment on table wa_space_roles is
  'Space-scoped roles for WhatsApp phone numbers. space_key is a Jira project key; NULL means all spaces (super_admin only). The portal user owning the Jira connection is an implicit super admin and is not stored here.';
