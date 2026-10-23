-- Spec 0017 AC-11: every testbed gets a Domain, and a live testbed always has
-- an Authentik group pk (the group is predefined, the app no longer makes it).
-- Constraint and index names are a contract with server/db/constraint-errors.ts;
-- renaming one is a breaking change.
--
-- Dev and production share one database, so this guard runs where the owner
-- steps of the migration plan are done: no live testbed, and no deleted
-- testbed whose group the old worker has not yet removed and stamped.

lock table hol_app.testbeds in share row exclusive mode;

do $$
begin
  if exists (select 1 from hol_app.testbeds where deleted_at is null) then
    raise exception 'Delete every live testbed first (spec 0017).';
  end if;
  if exists (
    select 1 from hol_app.testbeds
    where deleted_at is not null
      and authentik_group_pk is not null
      and authentik_group_deleted_at is null
  ) then
    raise exception 'Wait for every deleted testbed''s group release first (spec 0017).';
  end if;
end $$;

-- Stored lower case. Null only on a row soft deleted before this migration.
alter table hol_app.testbeds
  add column domain text,
  add constraint testbeds_domain_format_check
    check (
      domain is null
      or (
        domain ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'
        and length(domain) <= 253
      )
    ),
  add constraint testbeds_domain_live_check
    check (deleted_at is not null or domain is not null),
  add constraint testbeds_live_group_check
    check (deleted_at is not null or authentik_group_pk is not null);

-- One live testbed per tenant domain, and one live testbed per group.
create unique index testbeds_domain_uq on hol_app.testbeds (domain)
  where deleted_at is null;
create unique index testbeds_group_pk_uq on hol_app.testbeds (authentik_group_pk)
  where deleted_at is null;
