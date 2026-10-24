-- Sets up the reservations database: the hol_app role, the two schemas, and
-- btree_gist. Not a migration (the app role cannot run it). Safe to rerun, and
-- a rerun puts the password from the secret file back on the role.
--
-- `npm run db:bootstrap` (and `npm run db:up`) pipe `\set pw '<value>'` and this
-- file over stdin into psql inside the db container, so the password never
-- shows in git, shell history, or a process list. It must not contain a
-- single quote.

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
select format('grant connect on database %I to hol_app', current_database()) \gexec

-- Verify
select rolname, rolconfig from pg_roles where rolname = 'hol_app';
select nspname, pg_get_userbyid(nspowner) as owner
  from pg_namespace where nspname in ('hol_app', 'hol_auth');
select extname from pg_extension where extname = 'btree_gist';
