-- Spec 0013 AC-34 (amended 2026-10-16): a GOOGLE key signs in either as a
-- service account (domain wide delegation) or through Google sign in (a
-- refresh token for one mailbox). The worker's breaker marks a key Google
-- stopped accepting. Constraint names are a contract with
-- server/db/constraint-errors.ts.

alter table hol_app.api_keys
  -- How a GOOGLE key signs in; null for every other type.
  add column google_auth text,
  -- Set by the worker's breaker, cleared by a successful Google call or a
  -- save with a new secret.
  add column google_rejected_at timestamptz;

alter table hol_app.api_keys add constraint api_keys_google_auth_check
  check (google_auth in ('service_account', 'oauth'));

-- Every GOOGLE key so far holds a service account key.
update hol_app.api_keys set google_auth = 'service_account'
  where type = 'GOOGLE';

-- Dropped and added again under the same name, since the name is a contract.
alter table hol_app.api_keys drop constraint api_keys_google_fields_check;
alter table hol_app.api_keys add constraint api_keys_google_fields_check check (
  (type = 'GOOGLE') = (
    sender_email is not null and calendar_id is not null and google_auth is not null
  )
  and (
    type = 'GOOGLE'
    or (dev_inbox is null and ops_bcc is null and google_auth is null and google_rejected_at is null)
  )
);
