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
npm run lint && npm run typecheck
npm run db:migrate   # Kysely Migrator over db/migrations/*.sql
```

- Local env: copy `.env.example` to `.env.local` (read by `npm run dev` and `db:migrate`; never commit real values).
- `db/bootstrap.sql` is a one time setup run by hand as `postgres` (creates the `hol_app` role and schemas), not a migration; its header has the exact command.

## Specs

Stored in `docs/specs/`. Format: `docs/specs/NNNN-title/index.md`.

## Rules

- Functional style: pure functions by default, no shared mutable state (module variables are constants, lazy caches aside), side effects (DB, Authentik, Google, Cloudflare) kept at the edges in `server/`.
- Prefer plain functions and composition over classes; `map`/`filter`/`reduce` over loops when clearer; never mutate inputs (`readonly` types).
- Errors: expected failures return a typed `Result` (`{ ok: true, value } | { ok: false, error }`); throw only for bugs and broken invariants. Server Actions map a `Result` to a user facing message.
- Strict TypeScript: no `any`, no non null `!` without a comment, exhaustive `switch` on unions (`never` check). Parse every boundary (input, env, external API) with Zod.
- Env: each process validates its env through the Zod schemas in `server/env.ts`, failing fast at start, never during `next build`. No `process.env` reads elsewhere.
- Named exports only, except where Next.js requires a default (`page`, `layout`, `route`, `error`, etc.).
- Layout follows the scaffold: `app/` routes, `components/` (shadcn in `components/ui/`), `server/` (every module imports `server-only`), `lib/` (safe on both sides), `db/`, `scripts/`. Import via `@/`.
- Tests: Vitest for units and DB integration, Playwright for key flows. Pure logic gets plain input/output tests, no mocks.

## Tooling

To be installed by `/develop tooling`:
- ESLint (`eslint-config-next`, already installed) plus Prettier with `prettier-plugin-tailwindcss`.
- Pre-commit: Husky + lint-staged (ESLint and Prettier on staged files) plus `npm run typecheck`.
- CI: GitHub Actions on push runs lint, typecheck, and tests (the image build from spec 0001 comes later).

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

_Drafted by /audit from the repo, worth a quick human pass. Edit freely: once a line stops matching this draft, later runs treat it as curated and will flag rather than overwrite it._
