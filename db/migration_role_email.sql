-- Optional email on a role grant, so a Jira assignee (matched by the email
-- Jira returns) can be mapped to the WhatsApp phone we should notify.
-- Nullable: assignment still works without it — you just get no message.
alter table wa_space_roles add column if not exists email text;
create index if not exists idx_wa_space_roles_email
  on wa_space_roles (user_id, lower(email)) where email is not null;
comment on column wa_space_roles.email is
  'Jira account email for this phone. Lets a ticket assignment notify the assignee over WhatsApp.';
