<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Nile HOL Reservations

## Stack

- **Language / Runtime**: TypeScript (strict), Node 24 LTS
- **Framework**: Next.js 16 App Router, React 19.2 (`proxy.ts`, not `middleware.ts`)
- **Key dependencies**: Kysely over `pg` (its own pinned Postgres container, schemas `hol_app` / `hol_auth`), Zod, Tailwind v4 + shadcn/ui, Better Auth against Authentik
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
npm run worker       # background worker; exits unless WORKER_ENABLED=true; reconciles the real Authentik groups, so run one at a time
npm run calendar:backfill # queues a calendar job for every confirmed booking not yet ended; dry run, -- --apply writes
npm run test:e2e     # Playwright against the running dev server on the LAN IP; skips without ~/secrets/hol-test-*.pw
npm run authentik:setup   # dry run; master token and APP_URLS passed for that run only, --apply writes (owner approves shared changes)
npm run secrets:keygen    # prints a new encryption keyring entry (key id plus a 32 byte key) to stdout; writes no file
npm run build:bundle      # esbuild bundles of the worker and migrate into dist/ (the image runs these)
scripts/backup.sh         # on the BACKUP host: pulls encrypted backups over SSH from the servers in backup/backup.conf, keeps 5, only when something changed (--force, --dry-run, --list)
scripts/restore.sh        # puts a backup back on a new server (--verify restores into a throwaway Postgres and changes nothing)
scripts/deploy.sh         # build the image, pg_dump, then compose up migrate, web, worker (docker/compose.yaml)
```

- The app runs as the Compose project `reservations` from `docker/compose.yaml` (settings in the gitignored `docker/.env`, secrets mounted from `SECRETS_DIR`); its `worker` container is the one worker. The README's "Running with Docker" section has prerequisites and operations.

- Local env: copy `.env.example` to `.env.local` (read by `npm run dev`, `db:migrate`, `db:codegen`, and Vitest; never commit real values).
- Dev runs on the LAN IP (`http://10.1.255.18:3000`), because the Authentik proxy refuses requests that mention localhost. `APP_URL` must match the URL the browser uses, or sign in fails with `state_mismatch`.
- A Better Auth config change in `server/auth/index.ts` needs a dev server restart: `auth()` is cached on `globalThis`, so a hot reload keeps the old instance.
- `db/bootstrap.sql` is a one time setup run by hand as `postgres` (creates the `hol_app` role and schemas), not a migration; its header has the exact command.

## Specs

Stored in `docs/specs/`. Format: `docs/specs/NNNN-title/index.md`.

## Rules

- Functional style: pure functions by default, no shared mutable state (module variables are constants, lazy caches aside), side effects (DB, Authentik, Google, Cloudflare) kept at the edges in `server/`.
- Prefer plain functions and composition over classes; `map`/`filter`/`reduce` over loops when clearer; never mutate inputs (`readonly` types).
- Errors: expected failures return a typed `Result` (`{ ok: true, value } | { ok: false, error }`); throw only for bugs and broken invariants. Server Actions map a `Result` to a user facing message. The type and `ok`/`err` helpers live in `lib/result.ts`; DB constraint violations become a `Result` through `mapConstraintError` in `server/db/constraint-errors.ts`.
- Refusals inside a transaction: throw `Refusal` from `server/db/refusal.ts` and wrap the transaction in `refusable()`, so every write rolls back and the caller still gets a `Result` (the lock first pattern in `server/users/learners.ts` is the reference).
- Schema: `server/db/types.ts` is generated (never hand edit; Prettier skips it). Constraint and index names are a contract with `mapConstraintError`, so renaming one is a breaking change. Every `CHECK (col in (...))` list has a matching Zod enum in `lib/db-enums.ts`, registered in `checkLists`; a parity test compares them to the live schema.
- Strict TypeScript: no `any`, no non null `!` without a comment, exhaustive `switch` on unions (`never` check). Parse every boundary (input, env, external API) with Zod.
- Env: each process validates its env through the Zod schemas in `server/env.ts`, failing fast at start, never during `next build`. No `process.env` reads elsewhere.
- Time: the database is the clock. Booking, slot, and access decisions use SQL `now()` or `dbNow()` from `server/db/bookings.ts`, never `Date.now()`. Times are stored UTC and shown in the viewer's IANA zone through `lib/format-time.ts`.
- Forms: Server Actions parse input with the Zod schemas in `lib/` (`booking-input.ts`, `catalog-input.ts`) and return field errors keyed by dotted path through `fieldErrors` in `lib/form-errors.ts`.
- Admin row edit and delete (Testbed Types is the reference): the page binds the row id (`action.bind(null, id)`) and the action checks it with `z.uuid()`; edit fields read their defaults once on open (`useState`), because `revalidatePath` refreshes props while the dialog is still closing; delete is a check action plus a remove action typed by `lib/delete-flow.ts`, and the remove runs `lockForDelete`, the blocker query, then the soft delete in one transaction.
- Audit: every audit action name is in the `AuditAction` enum in `lib/audit-actions.ts` (no DB CHECK, so a new action needs no migration); write rows with `audit()` from `server/audit.ts` inside the same transaction. Edit metadata comes from `changedFields` in `lib/changed-fields.ts`, which compares only the keys you list (never list a secret).
- Secrets at rest: encrypt with `encryptSecret` from `server/crypto/secrets.ts` (AES-256-GCM, bound to table, column, and row id through `secretAad`), using the keyring from `encryptionEnv()` in `server/env.ts` (`APP_ENCRYPTION_KEYS_FILE`, `APP_ENCRYPTION_ACTIVE_KEY_ID`). A stored secret never goes back to the client, a log, an error, or audit metadata: in app code `secret_ciphertext` may appear only in `server/catalog/api-keys.ts` (generated types aside), enforced by `tests/secret-column-scan.test.ts`.
- Client OS logins (`testbed_clients.os_username`, `os_password`) are plain text by design: in app code `os_password` may appear only in `server/catalog/testbeds.ts` (generated types aside), enforced by `tests/os-password-scan.test.ts`. They reach the browser only through `loadTestbedForEdit`, when the edit dialog opens (`FormDialog` `onOpen`, `canSave`, `onClosed`; `components/admin/testbed-edit-dialog.tsx` is the reference), never in a list, log, error, or audit metadata (edits audit client counts only). The learner gets them in the booked, rescheduled, and reminder emails: the worker reads them at send time through `clientLoginsForBooking`, so they are never copied into `email_messages.details` or a job row.
- Authentik groups are the owner's (spec 0017): app code never creates, updates, or deletes one, only reads it and changes membership, enforced by `tests/group-writes-scan.test.ts`. A testbed's `group_name` must equal a group that carries the `hol_testbed_group` marker, checked by `findTestbedGroup` in `server/authentik/groups.ts`; `name` is the learner facing text, and `tests/group-name-scan.test.ts` keeps `group_name` out of learner code.
- Client IP for rate limits comes only from `clientIp()` in `server/request-ip.ts` (it trusts `CF-Connecting-IP` only when `TRUST_PROXY_HEADERS=true`).
- Turnstile renders explicitly app wide (one script mode) through `Turnstile` in `components/turnstile.tsx`: take the token from `onToken`, reset with `resetSignal` after every reply (a token is never reused), and the widget removes itself on unmount; there is no global reset.
- Named exports only, except where Next.js requires a default (`page`, `layout`, `route`, `error`, etc.).
- Layout follows the scaffold: `app/` routes, `components/` (shadcn in `components/ui/`), `server/` (every module imports `server-only`), `lib/` (safe on both sides), `db/`, `scripts/`, `worker/` (the worker process entry). Import via `@/`.
- Design system: build all UI to `design.md` (art direction and the maximalist product bar); token values live in CSS.
- Tests: Vitest for units and DB integration, Playwright for key flows. Pure logic gets plain input/output tests, no mocks. DB tests share the local database with the dev server, so they run inside `inRollback` from `server/db/testing.ts` (always rolled back, never commit) and skip when no database is configured (CI).
- Test helpers: `asConn(trx)` in `server/db/testing.ts` lets code that opens its own `conn.transaction()` run inside `inRollback`. A test that changes the schema (`applyBookingGapMigration`, `restoreOldOverlapRule`) runs in `inRollbackDdl`, which takes the DDL advisory lock alone, or its `ALTER TABLE` lock starves the DB tests in other files; `inRollbackNested` is for a second concurrent connection inside a test that already holds it, and `tests/ddl-lock-scan.test.ts` enforces it. `server/authentik/testing.ts` is the in memory fake Authentik behind the real SDK.
- Auth: every protected page and Server Action calls `requireAdmin()` or `requireLearner()` from `server/auth/require.ts` (public actions go on the allow list in `tests/server-actions-require.test.ts`).
- Signed in learner on a public path (`/book`): read the session with `currentSession()` (never `requireLearner()`, which redirects) and take identity from the session's `users` row, never from the post; `sessionAccount` in `server/booking/account.ts` is the reference.
- Learner booking changes (cancel, reschedule): the page binds the booking id and the `version` it showed; the action locks the learner `FOR SHARE`, then the booking `FOR UPDATE` by id, session learner, `ends_at > now()`, and version, and a miss is `stale`. Every learner booking read filters by the session learner's `user_id`; `server/booking/manage.ts` is the reference.
- Set password links (spec 0014): the app stores only `sha256(token)` in `set_password_links`. The page and the `startSetPassword` action read state through one function, `linkState` in `server/auth/set-password-links.ts` (a GET changes nothing); the action locks the user `FOR SHARE`, then the link `FOR UPDATE`, as the lock first pattern does. Only misses count toward the per IP limit, and every dead case shows the same message.
- Keeping a token in the URL out of Referer: set `referrer: "strict-origin"` in the page metadata, never `no-referrer`. Under `no-referrer` a native form POST (a click before hydration) sends `Origin: null`, and Next refuses the Server Action as "Invalid Server Actions request". A `Referrer-Policy` response header overrides the meta tag, so none may reach such a page with another value (spec 0014 AC-9; `/set-password/[token]` is the reference).
- Lab links (Nile Portal, LMS, client URLs) reach a learner only through `ownLabAccess` in `server/booking/lab-access.ts`: the session learner's own verified booking, every miss is `missing` (a 404), and a guest reply never carries them.
- Email and calendar: a booking change queues its notice with `queueBookingNotice` (`server/jobs/booking-notice.ts`) in the same transaction; the web process never calls Google for a booking, the worker sends.
- Cleanup hook (spec 0021): cancelling or moving a Current booking queues a `cleanup_notify` job (`queueCleanupNotice`) when a live `CLEANUP` API key exists, and only the worker's "cleanup hook" step sends the signed call. That key's URL is a secret like its signing secret (a webhook path is a capability): neither goes to a log, a job payload, `last_error`, audit metadata, or the browser (the list shows only the host), enforced by `tests/cleanup-hook-scan.test.ts`.
- Search indexing: every page is `noindex, nofollow` by default (root layout metadata), and a page opts in explicitly (today only `/`). A page whose metadata uses relative URLs sets `metadataBase` from `appUrl()` in `server/env.ts` and is `force-dynamic`, so `next build` reads no env. Nothing public (`robots.txt`, sitemap, learner pages) names `ADMIN_ENTRY_PATH`.

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
- [shadcn-syntax-calendar-datepicker](.claude/skills/shadcn-syntax-calendar-datepicker/): `impertio-studio/shadcn-ui-claude-skill-package`, shadcn Calendar on react-day-picker v9 (modes, matchers, styling)
- [shadcn-errors-react-day-picker-v9](.claude/skills/shadcn-errors-react-day-picker-v9/): `impertio-studio/shadcn-ui-claude-skill-package`, react-day-picker v9 errors and v8 props that no longer exist
- [base-ui](.claude/skills/base-ui/): `itechmeat/llm-code`, Base UI (`@base-ui/react`) components, render props, forms, overlays
- [shadcn-baseui](.claude/skills/shadcn-baseui/): `thunderboltdev/shadcn-baseui`, Base UI patterns in shadcn (no Radix `asChild`)
- [react-email](.claude/skills/react-email/): `resend/react-email`, React Email templates and rendering (the booking emails in `server/email/`)
- [gws-gmail](.claude/skills/gws-gmail/): `googleworkspace/cli`, Gmail send and read
- [gws-calendar](.claude/skills/gws-calendar/): `googleworkspace/cli`, Google Calendar events
- Declined: `morksen123/base-ui-mcp-server` (third party Base UI MCP server), 2026-10-11

MCP servers: better-auth `https://mcp.better-auth.com/mcp`, docs search and setup help (connected; `npx auth@latest mcp --claude-code`), next-devtools-mcp (recommended), github-mcp-server (recommended), pg-mcp-server in read only mode (recommended)

## Context files

<!-- Nested AGENTS.md files are listed here as they are created -->
- [server/authentik/AGENTS.md](server/authentik/AGENTS.md): Authentik API client, the write guard, learner provisioning, and token rules
- [server/worker/AGENTS.md](server/worker/AGENTS.md): the background worker, its lock, tick loop, sweepers, and the access reconciler
- [server/users/AGENTS.md](server/users/AGENTS.md): learner admin from the console, the add saga, the lock first pattern, and the admin timezone
- [server/jobs/AGENTS.md](server/jobs/AGENTS.md): the job queue, booking emails and the calendar mirror, the breaker, and the email templates in `server/email/`
- [server/google/AGENTS.md](server/google/AGENTS.md): every Google call, the two sign in methods, the token, the key save check, and the sign in cookie

_Drafted by /audit from the repo, worth a quick human pass. Edit freely: once a line stops matching this draft, later runs treat it as curated and will flag rather than overwrite it._
