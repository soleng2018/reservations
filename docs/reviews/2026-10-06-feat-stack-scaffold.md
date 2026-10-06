# Review, feat/stack-scaffold, 2026-10-06

**Reviewed by**: Sonnet 5.5 (author on unknown model)
**Scope**: 19 files (plus 114 vendored skill files and package-lock.json), branch vs main
**Verdict**: Changes requested

## Summary
Scaffolds the Next.js 16 app with a lazily parsed Zod env, a lazy single-pool Kysely instance, a DB-checking `/api/health` route, a Kysely-based SQL migration runner, and the one-time `db/bootstrap.sql`. The shape matches spec 0001 well and the lazy env / `server-only` discipline is correct. Two majors: an unguarded pg Pool error path that can crash the process, and a bootstrap statement that may overwrite InsForge's internal schema list instead of extending it. The migration script bypasses the project's own env convention. No test runner exists yet (none-yet): noted once, correctness findings weighted accordingly.

## Major
### 🟠 pg Pool has no `error` listener, `server/db/index.ts:13`
**Problem**: `new Pool(...)` is created without `pool.on("error", ...)`. node-postgres emits `error` on the pool when an idle client's connection drops (DB restart, network blip, `pg_terminate_backend`).
**Why it matters**: An unhandled `error` event on an EventEmitter throws as an uncaught exception and kills the `web` (and later `worker`) process. DB and web share a host with InsForge, which is upgraded and restarted, so this is a realistic path, not a corner case.
**Suggested fix**: Attach an error handler that logs and lets the pool discard the client. Consider `connectionTimeoutMillis` and `idleTimeoutMillis` while there (see minor on health).

### 🟠 Bootstrap may replace InsForge's schema exclusion list, `db/bootstrap.sql:32-45`
**Problem**: The block builds the new `insforge.internal_schemas` from `current_setting(..., true)` and falls back to `''`. The spike notes (rationale.md, consequence 2) say this database setting replaces InsForge's default list, and the default may live outside the database-level setting (PostgREST/InsForge config or code). If the setting is not already stored at database level, the result is `hol_app,hol_auth` only. The header comment ("Adds only missing entries") hides this.
**Why it matters**: InsForge's own internal schemas could drop out of the hidden list and become exposed through PostgREST, a security regression on a shared prod/dev database. Not verified against the live instance, so severity rests on that unknown.
**Suggested fix**: Have the script fail (or require an explicit psql variable with the base list) when the current value is empty, rather than defaulting to empty. Print the before and after values. Document re-checking on InsForge upgrade, as the rationale already says.

### 🟠 `scripts/migrate.ts` bypasses `server/env.ts` and Zod, `scripts/migrate.ts:29-46`
**Problem**: Reads `process.env` directly, with its own `password()` duplicating `secret()` in `server/env.ts`, and `Number(process.env.DATABASE_PORT ?? 5432)` yields `NaN` on a bad value. AGENTS.md: "No `process.env` reads elsewhere", "Parse every boundary with Zod"; spec says `server/env.ts` holds a schema per process (web, worker, migrate).
**Why it matters**: Two divergent env parsers for the same variables, and a migration run against a shared prod/dev database is the worst place for loose parsing. `server/env.ts` imports `server-only`, so it cannot be imported by a tsx script as is.
**Suggested fix**: Split the pure schema and secret reader into a module without `server-only` (or add a `migrateEnv()` there with the stub alias the spec plans for the worker), and use it from the script.

## Minor
### 🟡 Unhandled rejection and unclosed pool on failure, `scripts/migrate.ts:68`
`main()` is called with no `.catch`. If `password()` or `readdir` throws, Node prints a stack trace (unhandled rejection) rather than a clean message, and `db.destroy()` is skipped when `migrateToLatest` itself throws. Wrap in try/finally and map to an explicit exit code.

### 🟡 `class SqlFileProvider` against the functional-style rule, `scripts/migrate.ts:13`
`MigrationProvider` is only an object with `getMigrations`; a plain object/function factory satisfies it and matches AGENTS.md ("prefer plain functions over classes"). The `for` loop with a mutated `migrations` record (lines 17-24) can also be a `reduce`/`Object.fromEntries`.

### 🟡 Health route hides the failure cause and can hang, `app/api/health/route.ts:10`
The bare `catch` swallows the error, including a `dbEnv()` Zod failure (misconfiguration), and reports it as "unreachable" with nothing logged. With no `connectionTimeoutMillis` on the pool, a blackholed DB leaves the request (and the compose healthcheck) hanging. Log the error server side and add a connection timeout. Response body is appropriately minimal.

### 🟡 Pool recreated on dev hot reload, `server/db/index.ts:7`
Module-level `instance` resets when Next dev reloads the module, leaking up to 10 connections per reload against the shared prod/dev Postgres. Cache on `globalThis` in dev (or rely on the pool's idle timeout) to avoid exhausting connections.

### 🟡 Password visible in process arguments, `db/bootstrap.sql:5`
The documented `-v pw="$(cat ...)"` puts the password in the `docker exec`/`psql` command line (visible via `ps`, shell history if typed). Also, a failed `create/alter role ... password` can echo the statement, with the password, to the server log. Prefer reading from stdin or a file inside the container and note the log exposure.

### 🟡 `@types/node` major mismatches runtime, `package.json:25,35`
`engines.node >=24` and AGENTS.md says Node 24, but `@types/node` is `^20`, so Node 21-24 APIs are not typechecked. Move to `^24`.

### 🟡 Migration runner not available in the planned image, `package.json:11,31`
`tsx` is a devDependency and spec 0001 plans the image to carry `dist/worker.js` and `db/migrations` only. The `migrate` service will need either a bundled script (like the worker) or `tsx` in the runtime image. Record this for the Dockerfile feature.

## Nits
- ⚪ `server/db/types.ts:3`, the eslint-disable for an empty interface is fine now; remove when codegen output lands.
- ⚪ `server/env.ts:27`, spreading all of `process.env` into the schema parse is harmless (Zod strips unknowns) but passing only the `DATABASE_*` keys is clearer.
- ⚪ `.gitignore:42`, the `!.env.example` negation is placed under `# typescript`; move it next to the `.env*` rule.
- ⚪ `app/api/health/route.ts:5`, no explicit return type on `GET`; acceptable, but the convention elsewhere is strict.

## Strengths
- Env is parsed lazily and cached, `server-only` is imported in every server module, and `next build` needs no values, exactly as the spec requires.
- Secrets use the `NAME_FILE` convention consistently, and the `.env.example` carries no real values.
- Bootstrap is idempotent, scoped to a least-privilege role, keeps the password out of output with `\g /dev/null`, and ends with verification queries.
- Migrations are forward-only SQL files in a transaction each, with the history table in the app-owned schema.
- Vendored skills: no unsafe content found (grep for pipe-to-shell, eval, base64 decode, prompt-injection phrasing was clean); 7 relative symlinks from `.claude/skills` into `.agents/skills` look intended.

## Test coverage
Test signal is none-yet: no runner is installed (Vitest is planned for feature 2). Noted once. Before the first feature lands, the pure parts here (`dbEnv` schema defaults and failures, migration filename filtering) are the obvious first unit tests; `/check verify` should exercise `/api/health` both up and with the DB down, and the Pool error path.
