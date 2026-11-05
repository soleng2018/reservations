-- Spec 0026: each Testbed Type links one Authentik group (the LMS reads it).
-- Both columns stay null until the group is made, linked, or backfilled.
-- Constraint and index names are a contract with server/db/constraint-errors.ts.

alter table hol_app.testbed_types add column authentik_group_pk uuid;
alter table hol_app.testbed_types add column authentik_group_origin text;

alter table hol_app.testbed_types add constraint testbed_types_group_origin_check
  check (authentik_group_origin in ('created', 'reused'));
alter table hol_app.testbed_types add constraint testbed_types_group_pair_check
  check ((authentik_group_pk is null) = (authentik_group_origin is null));

-- One live type per group. A soft deleted type keeps its pk without blocking.
create unique index testbed_types_group_pk_uq on hol_app.testbed_types (authentik_group_pk)
  where deleted_at is null and authentik_group_pk is not null;
