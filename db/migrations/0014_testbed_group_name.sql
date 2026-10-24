-- Spec 0018 AC-1: a testbed gets a Group Name, the exact name of its Authentik
-- group. `name` stays and becomes the free text name learners see. Every row,
-- live or soft deleted, starts with name = group_name, so nothing changes until
-- an admin edits a Name. Constraint and index names are a contract with
-- server/db/constraint-errors.ts; renaming one is a breaking change.
--
-- Dev and production share one database: run this together with
-- scripts/deploy.sh (see the spec's migration plan).

set local lock_timeout = '5s';

alter table hol_app.testbeds add column group_name text;

update hol_app.testbeds set group_name = name;

alter table hol_app.testbeds
  alter column group_name set not null,
  add constraint testbeds_group_name_trimmed
    check (group_name = btrim(group_name) and group_name <> '');

create unique index testbeds_group_name_lower_uq
  on hol_app.testbeds (lower(group_name))
  where deleted_at is null;
