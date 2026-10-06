-- One time setup for the reservations app inside InsForge's Postgres.
-- Not a migration: the app role cannot run it. Run by hand as postgres:
--
--   { printf "\\set pw '%s'\n" "$(cat <secret file>)"; cat db/bootstrap.sql; } |
--     docker exec -i insforge-postgres psql -U postgres -d insforge -v ON_ERROR_STOP=1
--
-- printf is a shell builtin, so the password goes through stdin and never
-- shows in process arguments. It must not contain a single quote.
--
-- Safe to rerun. The internal_schemas setting applies to new connections
-- only, so restart PostgREST afterwards.

-- Keep the password out of the server log if a statement below fails.
set log_statement = 'none';
set log_min_error_statement = panic;

-- \g /dev/null keeps the password out of the output.
select set_config('hol.pw', :'pw', false) \g /dev/null

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'hol_app') then
    execute format('create role hol_app login password %L', current_setting('hol.pw'));
  else
    execute format('alter role hol_app login password %L', current_setting('hol.pw'));
  end if;
end $$;

create schema if not exists hol_app authorization hol_app;
create schema if not exists hol_auth authorization hol_app;
revoke all on schema hol_app, hol_auth from public;

create extension if not exists btree_gist;

alter role hol_app set search_path = hol_app, hol_auth, public;
grant connect on database insforge to hol_app;

-- Hide both schemas from InsForge's REST layer. Adds only missing entries.
-- This setting replaces InsForge's default list, so refuse to run when it is
-- unset: writing just our schemas would expose InsForge's own. Recheck after
-- every InsForge upgrade.
do $$
declare
  current_list text := coalesce(current_setting('insforge.internal_schemas', true), '');
  entries text[] := array_remove(string_to_array(replace(current_list, ' ', ''), ','), '');
  s text;
begin
  if cardinality(entries) = 0 then
    raise exception 'insforge.internal_schemas is empty; set it to InsForge''s default list first';
  end if;
  raise notice 'internal_schemas before: %', current_list;
  foreach s in array array['hol_app', 'hol_auth'] loop
    if not s = any(entries) then
      entries := entries || s;
    end if;
  end loop;
  execute format('alter database insforge set insforge.internal_schemas = %L',
                 array_to_string(entries, ','));
  raise notice 'internal_schemas after: %', array_to_string(entries, ',');
end $$;

-- Verify
select rolname, rolconfig from pg_roles where rolname = 'hol_app';
select nspname, pg_get_userbyid(nspowner) as owner
  from pg_namespace where nspname in ('hol_app', 'hol_auth');
select extname from pg_extension where extname = 'btree_gist';
select setconfig from pg_db_role_setting s join pg_database d on d.oid = s.setdatabase
  where d.datname = 'insforge' and s.setrole = 0;
