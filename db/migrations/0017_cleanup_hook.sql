-- Spec 0021: the CLEANUP API key (the URL and signing secret of the hook the
-- worker calls when a Current booking ends early) and its job kind. Constraint
-- and index names are a contract with server/db/constraint-errors.ts.

alter table hol_app.api_keys drop constraint api_keys_type_check;
alter table hol_app.api_keys add constraint api_keys_type_check
  check (type in ('IDP', 'AI', 'CLOUDFLARE', 'GOOGLE', 'CLEANUP'));

-- At most one live CLEANUP key, so the worker never has to choose.
create unique index api_keys_one_cleanup_uq on hol_app.api_keys (type)
  where type = 'CLEANUP' and deleted_at is null;

-- Set by the worker when a hook job fails for good, cleared by a 2xx or a
-- save that changes the key. Only a CLEANUP key may hold it.
alter table hol_app.api_keys add column cleanup_failed_at timestamptz;
alter table hol_app.api_keys add constraint api_keys_cleanup_fields_check
  check (type = 'CLEANUP' or cleanup_failed_at is null);

alter table hol_app.jobs drop constraint jobs_kind_check;
alter table hol_app.jobs add constraint jobs_kind_check
  check (kind in ('send_email', 'calendar_upsert', 'calendar_delete', 'send_welcome', 'cleanup_notify'));
