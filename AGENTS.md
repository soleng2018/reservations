<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Nile HOL Reservations

## Stack

- **Language / Runtime**: TypeScript (strict), Node 24 LTS
- **Framework**: Next.js 16 App Router, React 19.2 (`proxy.ts`, not `middleware.ts`)
- **Key dependencies**: Kysely over `pg` (InsForge Postgres, schemas `hol_app` / `hol_auth`), Zod, Tailwind v4 + shadcn/ui, Better Auth against Authentik
- **Package manager**: npm
- Full decision and build invariants: [docs/specs/0001-stack-architecture/index.md](docs/specs/0001-stack-architecture/index.md)

## Build approach

Tracer Bullet (prove one real thread through every layer first, then thicken it one strand at a time).

## Commands

```bash
npm install
npm run dev          # never runs migrations or the worker
npm run build
npm run lint && npm run typecheck   # typecheck runs next typegen first (PageProps, LayoutProps)
npm test             # Vitest (passes with no tests)
npm run format       # Prettier write; format:check is what CI runs
npm run db:migrate   # Kysely Migrator over db/migrations/*.sql
npm run db:codegen   # regenerate server/db/types.ts from the live schema (-- --verify to check)
npm run worker       # background worker; exits unless WORKER_ENABLED=true; shared DB, so it IS the prod worker (one at a time)
npm run test:e2e     # Playwright against the running dev server on the LAN IP; skips without ~/secrets/hol-test-*.pw
npm run authentik:setup   # dry run; master token and APP_URLS passed for that run only, --apply writes (owner approves shared changes)
```

- Local env: copy `.env.example` to `.env.local` (read by `npm run dev`, `db:migrate`, `db:codegen`, and Vitest; never commit real values).
- Dev runs on the LAN IP (`http://10.1.255.18:3000`), because the Authentik proxy refuses requests that mention localhost. `APP_URL` must match the URL the browser uses, or sign in fails with `state_mismatch`.
- `db/bootstrap.sql` is a one time setup run by hand as `postgres` (creates the `hol_app` role and schemas), not a migration; its header has the exact command.

## Specs

Stored in `docs/specs/`. Format: `docs/specs/NNNN-title/index.md`.

## Rules

- Functional style: pure functions by default, no shared mutable state (module variables are constants, lazy caches aside), side effects (DB, Authentik, Google, Cloudflare) kept at the edges in `server/`.
- Prefer plain functions and composition over classes; `map`/`filter`/`reduce` over loops when clearer; never mutate inputs (`readonly` types).
- Errors: expected failures return a typed `Result` (`{ ok: true, value } | { ok: false, error }`); throw only for bugs and broken invariants. Server Actions map a `Result` to a user facing message. The type and `ok`/`err` helpers live in `lib/result.ts`; DB constraint violations become a `Result` through `mapConstraintError` in `server/db/constraint-errors.ts`.
- Schema: `server/db/types.ts` is generated (never hand edit; Prettier skips it). Constraint and index names are a contract with `mapConstraintError`, so renaming one is a breaking change. Every `CHECK (col in (...))` list has a matching Zod enum in `lib/db-enums.ts`, registered in `checkLists`; a parity test compares them to the live schema.
- Strict TypeScript: no `any`, no non null `!` without a comment, exhaustive `switch` on unions (`never` check). Parse every boundary (input, env, external API) with Zod.
- Env: each process validates its env through the Zod schemas in `server/env.ts`, failing fast at start, never during `next build`. No `process.env` reads elsewhere.
- Time: the database is the clock. Booking, slot, and access decisions use SQL `now()` or `dbNow()` from `server/db/bookings.ts`, never `Date.now()`. Times are stored UTC and shown in the viewer's IANA zone through `lib/format-time.ts`.
- Forms: Server Actions parse input with the Zod schemas in `lib/` (`booking-input.ts`, `catalog-input.ts`) and return field errors keyed by dotted path through `fieldErrors` in `lib/form-errors.ts`.
- Audit: every audit action name is in the `AuditAction` enum in `lib/audit-actions.ts` (no DB CHECK, so a new action needs no migration); write rows with `audit()` from `server/audit.ts` inside the same transaction.
- Client IP for rate limits comes only from `clientIp()` in `server/request-ip.ts` (it trusts `CF-Connecting-IP` only when `TRUST_PROXY_HEADERS=true`).
- Named exports only, except where Next.js requires a default (`page`, `layout`, `route`, `error`, etc.).
- Layout follows the scaffold: `app/` routes, `components/` (shadcn in `components/ui/`), `server/` (every module imports `server-only`), `lib/` (safe on both sides), `db/`, `scripts/`, `worker/` (the worker process entry). Import via `@/`.
- Tests: Vitest for units and DB integration, Playwright for key flows. Pure logic gets plain input/output tests, no mocks. Dev and prod share one database, so DB tests run inside `inRollback` from `server/db/testing.ts` (always rolled back, never commit) and skip when no database is configured (CI).
- Test helpers: `asConn(trx)` in `server/db/testing.ts` lets code that opens its own `conn.transaction()` run inside `inRollback`; `server/authentik/testing.ts` is the in memory fake Authentik behind the real SDK.
- Auth: every protected page and Server Action calls `requireAdmin()` or `requireLearner()` from `server/auth/require.ts` (public actions go on the allow list in `tests/server-actions-require.test.ts`).

## Tooling

Installed:
- ESLint (`eslint-config-next`, with `eslint-config-prettier` last) plus Prettier with `prettier-plugin-tailwindcss`. Prettier skips Markdown, `docs/`, `context/`, and skills folders.
- Pre-commit: Husky + lint-staged (ESLint and Prettier on staged files) plus `npm run typecheck`.
- CI (`.github/workflows/ci.yml`): GitHub Actions on push runs lint, format check, typecheck, and tests (the image build from spec 0001 comes later). Playwright needs real Authentik, so it runs locally, not in CI.

## Git

- integration: on
- branch prefix: feat/
- commit: per-milestone

## Agent skills

- [kysely](.claude/skills/kysely/): `mindrally/skills`, Kysely query builder conventions
- [supabase-postgres-best-practices](.claude/skills/supabase-postgres-best-practices/): `supabase/agent-skills`, Postgres schema, migrations, indexes, RLS (generic Postgres; ignore Supabase specific parts)
- [vercel-react-best-practices](.claude/skills/vercel-react-best-practices/): `vercel-labs/agent-skills`, React 19 and Next.js patterns and performance
- [better-auth-best-practices](.claude/skills/better-auth-best-practices/): `better-auth/skills`, Better Auth setup and plugins
- [zod](.claude/skills/zod/): `pproenca/dot-skills`, Zod schemas and parsing
- [shadcn](.claude/skills/shadcn/): `shadcn-ui/ui`, shadcn/ui components
- [tailwind-design-system](.claude/skills/tailwind-design-system/): `wshobson/agents`, Tailwind v4 tokens and design system
- [vitest](.claude/skills/vitest/): `antfu/skills`, Vitest unit and integration tests
- [playwright-best-practices](.claude/skills/playwright-best-practices/): `currents-dev/playwright-best-practices-skill`, Playwright end to end tests
- [playwright-cli](.claude/skills/playwright-cli/): `microsoft/playwright-cli`, driving the browser
- [setup-pre-commit](.claude/skills/setup-pre-commit/): `mattpocock/skills`, Husky, lint-staged, Prettier setup

MCP servers: better-auth `https://mcp.better-auth.com/mcp`, docs search and setup help (connected; `npx auth@latest mcp --claude-code`), next-devtools-mcp (recommended), github-mcp-server (recommended), pg-mcp-server in read only mode (recommended; dev and prod share one database)

## Context files

<!-- Nested AGENTS.md files are listed here as they are created -->
- [server/authentik/AGENTS.md](server/authentik/AGENTS.md): Authentik API client, the write guard, learner provisioning, and token rules
- [server/worker/AGENTS.md](server/worker/AGENTS.md): the background worker, its lock, tick loop, sweepers, and the access reconciler

_Drafted by /audit from the repo, worth a quick human pass. Edit freely: once a line stops matching this draft, later runs treat it as curated and will flag rather than overwrite it._
