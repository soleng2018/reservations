-- Spec 0007 AC-8: testbed admin (feature 9). Constraint names are a contract
-- with server/db/constraint-errors.ts; renaming one is a breaking change.

-- Set once by the worker's teardown step, after Authentik confirmed the
-- deleted testbed's group is gone (removed, or already missing).
alter table hol_app.testbeds
  add column authentik_group_deleted_at timestamptz,
  add constraint testbeds_group_deleted_after_delete_check
    check (authentik_group_deleted_at is null or deleted_at is not null);

-- A client's OS login, sent to learners in the booking email (feature 15).
-- Plain text by the engineer's choice (spec 0007 Security model); only
-- server/catalog/testbeds.ts names os_password (tests/os-password-scan).
alter table hol_app.testbed_clients
  add column os_username text,
  add column os_password text,
  add constraint testbed_clients_os_username_length_check
    check (os_username is null or length(os_username) between 1 and 200),
  add constraint testbed_clients_os_password_length_check
    check (os_password is null or length(os_password) between 1 and 200),
  add constraint testbed_clients_password_needs_username_check
    check (os_password is null or os_username is not null);
