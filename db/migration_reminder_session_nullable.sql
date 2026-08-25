-- openwa_session_id is a legacy OpenWA field. On the Cloud API path there is
-- no OpenWA session, so scheduling any reminder (deadline, task, assignment
-- nudge) inserted NULL and hit this NOT NULL constraint — which, because it
-- fires AFTER the Jira ticket is created, made a successful "create with
-- deadline" report as a total failure. Make it nullable.
alter table wa_reminders alter column openwa_session_id drop not null;
