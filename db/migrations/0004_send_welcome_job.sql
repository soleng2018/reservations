-- Spec 0003 AC-6: the set password email job. The jobs.kind CHECK list grows
-- per feature (spec 0002); the constraint name stays the same.

alter table hol_app.jobs drop constraint jobs_kind_check;
alter table hol_app.jobs add constraint jobs_kind_check
  check (kind in ('send_email', 'calendar_upsert', 'calendar_delete', 'send_welcome'));
