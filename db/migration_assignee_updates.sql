-- Assignee alerts, 24h nudges, and Jira -> WhatsApp change notifications.

-- Secret that authenticates Jira's calls to /jira/events/<secret>. One per
-- connection so a leaked secret only exposes one tenant.
alter table wa_jira_connections add column if not exists jira_webhook_secret text;
alter table wa_jira_connections add column if not exists jira_webhook_id text;

-- A recurring reminder re-schedules itself instead of flipping sent=true.
-- interval_hours NULL = one-shot (all existing rows). recipient_phone lets a
-- reminder target someone OTHER than the operator who created it (the
-- assignee), which wa_reminders could not express before.
alter table wa_reminders add column if not exists interval_hours int;
alter table wa_reminders add column if not exists recipient_phone text;

-- Dedupe: one live nudge per (ticket, recipient). Reassigning a ticket
-- replaces the old nudge rather than stacking a second one.
create unique index if not exists uq_wa_reminders_assignment
  on wa_reminders (user_id, ticket_key, recipient_phone)
  where kind = 'assignment' and sent = false;
