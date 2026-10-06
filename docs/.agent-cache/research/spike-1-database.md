# Spike 1: direct Postgres on self-hosted InsForge (2026-10-05)

Spec 0001 Follow-up spike (1). Run against InsForge v2.3.2 at `/home/nova/insforge` (Postgres 15.18). Throwaway role `hol_spike` and schemas `spike_app`/`spike_ba`; all dropped afterwards.

## Results

| Question | Result |
|---|---|
| Direct `pg` login as a custom role | **Pass.** Non-superuser login role with scram password works from the host (`127.0.0.1:5432`) and from a container on `hol-internal` (`insforge-postgres:5432`). Wrong password is refused; `postgres` has no passwordless access from outside the container (`trust` is container-loopback only). |
| `btree_gist` | **Pass.** v1.7 available. A `exclude using gist (testbed_id with =, during with &&)` constraint on `tstzrange` rejected an overlapping booking and allowed adjacent `[)` ranges. It must be created by `postgres` (the app role lacks CREATE on the database). |
| Isolation of the app role | **Pass.** No access to InsForge's `auth`, `system`, or `public` schemas; cannot create schemas or extensions. |
| `app`/`auth` not exposed by InsForge REST | **Partial.** InsForge's event trigger `insforge_sync_postgrest_schemas` (`system.sync_postgrest_exposed_schemas`) auto-adds **every new schema** to PostgREST's `pgrst.db_schemas`, overriding `PGRST_DB_SCHEMA=public`. Our schemas were still unreadable (`anon`/`authenticated`/`project_admin` have no USAGE, so "permission denied"). Adding them to the database setting `insforge.internal_schemas` removes them from PostgREST entirely (PGRST106 via both PostgREST and InsForge's `/api/database/records` with the anon key). |
| InsForge CLI applies SQL migrations to self-host | **Yes, but unsuitable.** `insforge link --api-base-url --api-key` + `db migrations up` works against OSS, but executes as `project_admin` through the InsForge API (needs the admin `ik_` key at deploy time) and cannot touch schemas owned by the app role. **Use Kysely `Migrator` as the app role.** |

## Consequences for spec 0001 (for `/architect`)

1. **Schema name clash:** InsForge already owns a schema named `auth`. Better Auth's tables need another name (e.g. `hol_auth`); `app` is free but `hol_app` as a schema name pairs well with the role.
2. **One-time bootstrap as `postgres`** (not a migration): create the login role, create the app schemas owned by it, `revoke all ... from public`, `create extension btree_gist`, and set `alter database insforge set insforge.internal_schemas = '<InsForge default list>,<our schemas>'`. That setting replaces InsForge's default list, so re-check it on every InsForge upgrade (a new internal schema upstream would otherwise become exposed).
3. **Defense in depth stays:** no grants to `anon`/`authenticated`/`project_admin` on our schemas, plus RLS-with-no-policies, regardless of the exclusion setting.
4. **Migrations:** Kysely `Migrator` reading `db/migrations/*.sql`, run by the `migrate` service as the app role. Drop the InsForge CLI option.
5. **Environment gaps found:** Node is not installed on this host (dev needs Node 24, e.g. via nvm), and the `insforge`/`insforge-cli`/`insforge-debug` skills the spec says are installed user-wide are not present.
6. **Authentik reality:** the Authentik in use is the shared lab instance 2025.6.4 on this host (`authentik.nile.global`), not a dedicated AWS one.
