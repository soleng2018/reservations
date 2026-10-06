# 0001. Stack and architecture for Nile HOL Reservations

**Date**: 2026-10-04
**Status**: Proposed

## Summary

The reservations app is one Next.js 16 codebase. It runs as two Docker containers (a web server and a background worker) on the same on prem host as a self hosted InsForge database. It talks to that database directly over the private network, and it is published to the internet through a Cloudflare Tunnel. A dedicated, self hosted Authentik (on the company AWS instance) handles every sign in: admins and learners of this app, plus the lab URLs (Nile Portal over SAML, Moodle over OIDC, and Cloudflare Access for the browser based RDP/VNC desktops). Every 30 seconds the worker makes Authentik's `pod-<testbed>` groups match the bookings. That gives a learner lab access only during their booking: open VM sessions are cut off at the end, while Nile and Moodle block new sign ins at once and let open sessions run out on their own short timeout. Email and calendar go through Google APIs.

## Rationale

Reasoning, the options compared, the cross check, and references: see [rationale.md](rationale.md).

## Decision

**Chosen option**: Option 1: a self hosted Next.js monolith (web + worker containers) next to self hosted InsForge, using direct Postgres access, Authentik for all identity, and Google APIs for mail and calendar.

Build one TypeScript codebase. Deploy it as a `web` container and a `worker` container from the same image, on the InsForge host's private Docker network, behind Cloudflare Tunnel.

**Implementation skills**: `insforge-cli` (InsForge migrations and SQL) and `insforge-debug` (diagnosing InsForge issues) are installed user wide, not in the project skills dir. `insforge` (SDK app code) applies only if an InsForge feature beyond Postgres is ever used. Project skills: `better-auth-best-practices` (`better-auth/skills`, `.agents/skills/better-auth-best-practices/`) · `shadcn` (`shadcn-ui/ui`, `.agents/skills/shadcn/`) · `tailwind-design-system` (`wshobson/agents`, `.agents/skills/tailwind-design-system/`) · `zod` (`pproenca/dot-skills`, `.agents/skills/zod/`) · `vitest` (`antfu/skills`, `.agents/skills/vitest/`) · `playwright-cli` (`microsoft/playwright-cli`, `.agents/skills/playwright-cli/`) · `playwright-best-practices` (`currents-dev/playwright-best-practices-skill`, `.agents/skills/playwright-best-practices/`)

## Proposed stack

| Layer | Choice | Reason |
|---|---|---|
| Language / runtime | TypeScript (strict), Node 24 LTS, npm (existing `package-lock.json`) | One language across web, worker, and email templates. Node 24 is the current LTS line. |
| Architecture pattern | Modular monolith: one repo and one image, two processes (`web`, `worker`) | A small team and low volume (a handful of testbeds). The worker is split out only so timed work never runs twice or dies with a web restart. |
| Framework | Next.js 16 App Router (16.3.8 already scaffolded), React 19.2, `output: 'standalone'` | Already in place. Server Components read data, Server Actions change data, and `proxy.ts` (it replaced `middleware.ts` in 16) does coarse route gating. |
| API shape | Server Actions for all UI mutations. Route handlers only for the Better Auth handler (`/api/auth/[...all]`), `/api/health` (checks the DB), and `.ics` download. | Fewer layers. The worker calls the same service modules directly, never over HTTP. |
| UI | Tailwind CSS v4 + shadcn/ui (Radix primitives), `lucide-react` icons | Tailwind 4 is scaffolded. shadcn gives owned, accessible components that can be restyled to the Nile mock. lucide is shadcn's default icon set. |
| Forms / validation | Zod + react-hook-form + shadcn Form | One Zod schema checks input in the browser and again in the Server Action. Fits the testbed form's dynamic client rows. |
| Dates / time zones | date-fns + `@date-fns/tz`. Store `timestamptz` in UTC and an IANA zone name (e.g. `America/New_York`) per user. Containers run with `TZ=UTC`. | Small, works on plain `Date`, and handles 30 minute slot math and "Tue, Oct 13, 2026, 9:00 AM ET" formatting. |
| Primary DB | The Postgres inside self hosted InsForge (pinned version) on the same host, reached **directly** over the private Docker network by `web`, `worker`, and `migrate` as a dedicated login role `hol_app`. The InsForge SDK is not used at runtime. | Real transactions for booking, job leasing, and the provisioning saga. The owner's chosen backend still holds the data. |
| Query layer | Kysely over one `pg` Pool per process. Types generated from the live schema with `kysely-codegen` into `server/db/types.ts`. | A type safe SQL builder with no second schema owner. Better Auth uses the same Kysely/pg path natively. |
| Schemas and exposure | App tables in schema `app`, Better Auth tables in schema `auth`. `hol_app` has grants on those two schemas only. Neither schema is exposed through InsForge's REST API. If InsForge's REST layer can reach them, enable RLS with no policies (deny all) for its `anon`/`authenticated` roles. InsForge's REST port is never published. | The browser never reaching the data is enforced by the database, not only by the network. |
| DB integrity | Postgres constraints: an exclusion constraint so a testbed's booking time ranges never overlap (`btree_gist`), and uniqueness rules modeled in feature 3. Multi row changes (book, reschedule as one swap, cancel) run in one Kysely transaction. | Double booking is impossible even under races. Note for feature 3: "one Upcoming/Current booking per learner" depends on the clock, so it needs an explicit status or end time rule, not a `now()` index predicate. |
| Migrations | Plain SQL files in `db/migrations/` (`NNNN_name.sql`), applied forward only by a one shot `migrate` compose service before `web`/`worker` start. Runner: the InsForge CLI if it applies SQL migrations to a self hosted instance, otherwise Kysely's `Migrator` reading the same files (the spike decides, see Follow-up). Better Auth's tables are generated once with its CLI and committed as a migration. A rollback of the image never rolls back the schema, so migrations stay backward compatible for one release. | Reviewable in PRs, with a deterministic order at deploy. |
| Identity provider | Self hosted Authentik, **dedicated to HOL**, on the company AWS instance (public URL behind company proxy/LB), version pinned | Owner decision. It holds every admin and learner and protects every lab URL. Its public URL is the OIDC issuer for both the browser and the server. |
| App sign in | Better Auth with the `genericOAuth` plugin against one Authentik OIDC application (authorization code + PKCE). **Database sessions** in schema `auth` through the shared pg Pool. `session.expiresIn` 8 hours, cookie cache **off**, so every request checks the session row. `trustedOrigins` = `APP_URL`. | Deactivation or a role change ends access at once by deleting session rows. There are no cookie size limits. Role mapping from the groups claim is settled in the feature 4 spec. |
| Authentik API client | `@goauthentik/api` (official generated TypeScript client), pinned to the deployed Authentik version, wrapped in `server/authentik/` with a 10 second timeout and retries for safe reads only | Typed, and matches the server. Runner up: a thin hand written `fetch` wrapper (about 10 endpoints are used). |
| Authentik keys | **Master key**: used only by `npm run authentik:setup`, an idempotent script that creates or updates the app's OIDC provider and application and prints the client id and secret. It is run by the owner from their machine or the host, with the master token passed for that run only. It is never loaded by `web` or `worker`. **Provisioning key**: the token of a service account with a limited RBAC role, used for all runtime user, group, and session calls. | The scope rule. The RBAC role, and the fallback if Authentik cannot stop the token from touching admins, are settled in the feature 4 spec. |
| Lab access model | One Authentik group per testbed: `pod-<testbed-slug>`. The app creates and deletes the group. The worker's **access reconciler** adds and removes members. The **owner binds** each group to the lab's Authentik applications by hand. Every group write passes a guard that refuses any group not named `pod-*`. | Engineer's pick (least API rights). The prefix guard stops the token being used to add anyone to an admin or unrelated group. |
| Access reconciler | Every worker tick (30 seconds): compute the desired members of each `pod-*` group from the bookings active at DB `now()` (Current, and not cancelled), read the actual members from Authentik, then add the missing ones and remove the extra ones. For each removal, also delete the learner's Authentik sessions and call Cloudflare Access revoke. | A state based sync recovers by itself after a crash, a missed tick, a reschedule, or a cancel. Cancel and deactivation also trigger an immediate reconcile run so the cut off is instant. |
| Background jobs | A `jobs` table: `kind`, `payload`, `run_at`, `status` (`pending`, `running`, `done`, `failed`), `attempts`, `locked_until` (a lease), `last_error`, and a unique `idempotency_key`. The worker claims due rows in a transaction (`FOR UPDATE SKIP LOCKED`, setting `locked_until = now() + 5 min`). A crashed job's lease expires and it is retried. Exponential backoff, at most 8 attempts, then `failed` (logged at error level and shown in the console). Handlers re read current state and skip stale work (e.g. a reminder for a cancelled booking). Used for emails, calendar mirror writes, and reminders. Access is not a job; the reconciler owns it. | A database backed queue first: nothing extra to host. |
| Provisioning saga (guest booking) | 1) One transaction inserts the booking as `provisioning` (it holds the slot under the constraint). 2) Find or create the Authentik user by email. An existing user is reused without changing any of their attributes, and an existing admin is refused with a generic error. 3) Link the user and mark the booking `confirmed`. On failure: delete the booking, and delete the Authentik user only if this attempt created it. A worker **sweeper** runs the same compensation on any `provisioning` booking older than 10 minutes (a crash in the middle). | No orphan user and no stray booking, even if the process dies between steps. Group membership needs no saga step, because the reconciler adds it at start. |
| Worker process | Single replica. `worker/index.ts` bundled with esbuild to `dist/worker.js` in the same image, with `server-only` aliased to an empty stub module. On SIGTERM it finishes its current job and exits. One loop each tick: reconcile, sweep, claim jobs, purge expired rate limit rows (daily). | The Next.js standalone build has no separate process. A single replica keeps the reconciler simple. |
| Email sending | Gmail API (`@googleapis/gmail`). **Dev**: a personal Gmail with a one time OAuth consent (expect Google's "unverified app" warning; add the account as a test user, or publish the client *In production* so the refresh token doesn't expire after 7 days), storing the refresh token encrypted in the DB. **Prod**: a Workspace service account with domain wide delegation for scopes `gmail.send` and `calendar.events`, impersonating the HOL mailbox, which has SPF and DKIM set up for its domain. The driver is chosen by env. | The same HTTPS send code in both phases. Only the credentials differ. |
| Email content | React Email components rebuilt from the two standalone HTML files in `context/`, sharing the header, details card, and footer. Raw MIME built with nodemailer's `MailComposer` (HTML + text + `icalEvent`). `.ics` built with `ical-generator`: `ORGANIZER` is the sending mailbox, `UID` is `<booking id>@<APP_URL host>`, and `SEQUENCE` is the booking's version number, with `METHOD:REQUEST` on book and reschedule and `METHOD:CANCEL` on cancel. Every learner email BCCs `HOL_OPS_BCC`. The **set password / welcome email** is sent by the app the same way: the app gets a recovery link from Authentik's API and puts it in our template (Authentik needs no SMTP). | One message per change carries both the Nile template and the invite (scope rule). One sender, one look, and the send status is visible in the console. |
| Calendar | Google Calendar API (`@googleapis/calendar`) mirrors each booking onto one shared "HOL bookings" calendar (shared with the impersonated mailbox), with **no attendees** and `sendUpdates=none`, as an idempotent job keyed by booking id. The event id is stored on the booking. | An admin week view without Google sending its own invite emails to learners. |
| Bot protection | Cloudflare Turnstile on the guest Step 1 form, verified on the server before any Authentik call (Cloudflare's test keys in dev). Database backed rate limits keyed by `CF-Connecting-IP` (trusted only because the tunnel is the sole ingress) and by email: 5 booking attempts per IP per 10 minutes, 3 per email per hour. | Guest booking creates real Authentik users without sign in, so it must not be scriptable. |
| Secrets at rest | App level AES-256-GCM (`node:crypto`), ciphertext format `v1:<keyId>:<iv>:<tag>:<ciphertext>`, and a keyring so keys can be rotated. Covers API key secrets and the Gmail refresh token. | The database only ever stores ciphertext. Small and fully under our control. |
| Config and secrets | Plain settings come from env. Secrets come from files mounted by compose `secrets:` (with plain compose these are bind mounted, root readable files, not a vault), read through a `NAME_FILE` convention. `server/env.ts` holds a Zod schema per process (web, worker, migrate). It is parsed lazily when the process starts, **never during `next build`**, so the image builds without production values. | Bad config fails fast at start. The image stays environment free. |
| Repo layout | `app/` (routes) · `components/ui/` (shadcn) · `components/` (app components) · `server/` (services, `db/`, `authentik/`, `email/`, `jobs/`, `access/`, `env.ts`; every module imports `server-only`) · `worker/` (entry) · `emails/` (React Email) · `lib/` (code safe on both sides: Zod schemas, time helpers) · `db/migrations/` · `scripts/` (`authentik-setup.ts`, `seed-dev.ts`) · `docker/`. Path alias `@/*` to the repo root. | Clear server/client boundaries, with web and worker sharing `server/`. |
| Container image | A multi stage Dockerfile on `node:24-slim`. It runs as a non root user, copies the standalone output plus `.next/static` and `public`, plus `dist/worker.js` and `db/migrations`. `HOSTNAME=0.0.0.0`, `PORT=3000`, `TZ=UTC`. Healthcheck on `/api/health`. | One image for all three services. |
| Hosting | On prem Docker host. A compose project with `migrate` (runs once), `web` (`node server.js`), `worker` (`node dist/worker.js`), and `cloudflared`, joined to InsForge's Docker network | Owner decision (no Vercel Pro). Co located with the database. |
| Ingress | Cloudflare Tunnel publishes only `hol.<domain>` → `web:3000`. InsForge's API and dashboard are not published (or only behind Cloudflare Access for admins). Authentik is reached outbound at its AWS public URL. | No open inbound ports. It matches how the lab VMs are already exposed. |
| CI/CD | GitHub Actions on push to `main`: lint, typecheck, unit tests, build image, push to GHCR tagged `sha-<commit>` and `main`. Deploy is a manual `scripts/deploy.sh` on the host (`docker compose pull && docker compose up -d`, which runs `migrate` first). Roll back by pinning the previous `sha-` tag. | A built image to roll back to. Builds never load the lab host. Automating the pull can come later. |
| Route gating | `proxy.ts` lets public routes through (landing, guest booking, auth callbacks, health) and requires a session for learner routes and admin routes. The unlisted admin entry path comes from `ADMIN_ENTRY_PATH` (default `/l0gin`). Admin pages send `X-Robots-Tag: noindex`. Real authorization runs again in every Server Action and page (feature 4). | Coarse and cheap. Never the only check. |
| Observability | pino JSON logs to stdout (read via `docker logs`), with a request id or job id on every line and redaction of secrets and tokens. Error monitoring stays **Deferred** (scope). | Searchable from day one. No new service. |
| Testing | Vitest (units: slot math, booking rules, encryption, ICS, reconciler diff), Testing Library (components), Playwright (end to end against the local compose stack) | Fast and ESM native. Playwright exercises the real OIDC redirect. |
| Environments | **Local dev**: `docker/compose.dev.yml` with pinned InsForge and pinned Authentik (plus its own Postgres/Redis). `scripts/seed-dev.ts` runs the setup script, creates a dev admin and a dev learner, and adds the groups claim mapping. Personal Gmail. **Production**: the on prem host. Staging can be added later by cloning the compose project. | Anyone can boot the app with real sign in locally. The least to run now. |

### Runtime topology

| From | To | How | Credential |
|---|---|---|---|
| Browser | `web` | HTTPS via Cloudflare Tunnel | Better Auth session cookie (DB backed) |
| Browser | Authentik | OIDC redirect (authorization code + PKCE), set password link | Authentik sign in |
| `web`, `worker`, `migrate` | InsForge Postgres | `pg` over the private Docker network | `hol_app` role password (secret file) |
| `web`, `worker` | Authentik management API | HTTPS to the AWS public URL | Provisioning token |
| setup script (manual) | Authentik management API | HTTPS | Master token (that run only) |
| `worker` | Gmail API, Calendar API | HTTPS | Dev OAuth refresh token or prod service account file |
| `worker` | Cloudflare API (Access revoke) | HTTPS | Cloudflare API token limited to Access revoke |
| `web` | Cloudflare Turnstile verify | HTTPS | Turnstile secret |

### Lab access topology

How each lab URL is put behind Authentik and bound to `pod-<testbed-slug>`. Per testbed details are built in features 9 and 14.

| Lab system | Protocol to Authentik | Who configures | How the pod group grants access | How access is cut off |
|---|---|---|---|---|
| Nile Portal (one tenant per testbed, e.g. `u1.nile-global.cloud`) | SAML (Authentik is the IdP, the Nile tenant is the SP) | Owner: one SAML provider/application per tenant, bound to that testbed's pod group | One **shared** SAML property mapping turns membership in `pod-<x>` into the group attribute value `NileAdministrators-<x>` that Nile expects | Group removal plus deleting the learner's Authentik sessions block a new sign in at once. An open Nile session ends at **Nile's own timeout** (owner sets it as short as Nile allows; accepted). |
| Windows / macOS VMs (on prem, browser rendered RDP/VNC) | Cloudflare Access with Authentik as a generic OIDC IdP | Owner: one Access application per VM, with a policy matching the OIDC `groups` claim containing `pod-<x>`, and a 1 hour Access session | The groups claim at Access sign in | **Hard cut**: the reconciler calls Cloudflare Access revoke for the learner (looking up their Access user by email first). The 1 hour session is the backstop. |
| Moodle (LMS) | OIDC via the `auth_oidc` plugin | Owner: one Moodle application in Authentik, bound to the pod groups | Authentik's application binding to the pod groups | Same as Nile: new sign ins blocked at once, and an open session ends at Moodle's own (short) timeout (accepted). |
| This web app | OIDC (Better Auth) | `npm run authentik:setup` (master key) | Not group gated for learners. Admins are recognized by role (feature 4 spec). | Deleting the user's session rows on deactivation |

### Build invariants (every later spec and build must honor these)

- The browser never calls InsForge or the Authentik **management** APIs. All of it goes through `server/` modules marked `import 'server-only'`. (The browser does visit Authentik for sign in and set password pages.)
- The master Authentik key is never in the `web` or `worker` environment.
- Every Authentik group write goes through the `pod-*` prefix guard.
- All timestamps are stored as UTC `timestamptz`, with DB `now()` as the clock for scheduling. Display converts to the viewer's IANA zone (learner: their chosen zone; admin: their own zone).
- No overlapping bookings per testbed is enforced by a Postgres exclusion constraint, not only by app checks.
- Steps that touch Authentik and the DB together follow a persisted saga with a sweeper (as above), never a compensation held only in memory.
- Lab access membership is owned by the reconciler alone. No other code adds or removes `pod-*` members.
- Authorization is re checked in every Server Action and protected page through one shared helper (`server/auth/require.ts`), never by hand per action. A test asserts every Server Action calls it.
- Secrets are written only. No code path returns a decrypted secret to the browser.
- Email or calendar failure never rolls back a booking change. It is a retried job, and its status is visible to admins.
- If Authentik is down, sign in and guest booking fail with a clear "try again shortly" message, and the reconciler retries on its next tick. Existing bookings are untouched.

### Configuration required

Plain env:
- `APP_URL`: public base URL (e.g. `https://hol.<domain>`)
- `ADMIN_ENTRY_PATH`: unlisted admin sign in path (default `/l0gin`)
- `AUTHENTIK_URL`: Authentik base URL and OIDC issuer
- `AUTHENTIK_CLIENT_ID`: the app's OIDC client id (printed by the setup script)
- `DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_NAME`, `DATABASE_USER`: InsForge Postgres on the private network, role `hol_app`
- `APP_ENCRYPTION_ACTIVE_KEY_ID`: which keyring entry encrypts new values
- `GOOGLE_MAIL_DRIVER`: `oauth` (dev) or `service_account` (prod)
- `GOOGLE_OAUTH_CLIENT_ID`: dev driver
- `GOOGLE_SENDER`: the mailbox that sends and organizes invites
- `GOOGLE_SHARED_CALENDAR_ID`: the "HOL bookings" calendar
- `HOL_OPS_BCC`: ops mailbox copied on every learner email
- `CLOUDFLARE_ACCOUNT_ID`: for Access revoke
- `TURNSTILE_SITE_KEY`: guest form widget
- `LOG_LEVEL`, `NODE_ENV`, `TZ=UTC`, `PORT`, `HOSTNAME`

Secret files (`*_FILE`):
- `AUTH_SECRET_FILE`: Better Auth secret
- `AUTHENTIK_CLIENT_SECRET_FILE`: the app's OIDC client secret
- `AUTHENTIK_PROVISIONING_TOKEN_FILE`: runtime service account token
- `DATABASE_PASSWORD_FILE`: `hol_app` password
- `APP_ENCRYPTION_KEYS_FILE`: AES-256-GCM keyring (key id to base64 32 byte key)
- `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY_FILE`: stable Server Action key across deploys and replicas
- `GOOGLE_OAUTH_CLIENT_SECRET_FILE`: dev driver (the refresh token itself is stored encrypted in the DB)
- `GOOGLE_SERVICE_ACCOUNT_FILE`: prod driver, the service account JSON
- `CLOUDFLARE_API_TOKEN_FILE`: Access revoke only
- `TURNSTILE_SECRET_KEY_FILE`: guest form verification
- `AUTHENTIK_MASTER_TOKEN`: passed only to the setup script for one run, never stored with the app

## Consequences

**Positive**:
- One codebase and one image. Web and worker share every service module, so there is no drift between "what the UI does" and "what the job does".
- Double booking is impossible at the database level, and multi step writes are real transactions.
- Lab access heals itself: whatever happened before, each tick makes the groups match the bookings.
- Deactivation ends app sessions at once (DB sessions).
- No inbound ports are open. Every lab URL and the app share one identity, and one learner username works everywhere. Nothing is paid beyond existing infrastructure.

**Negative / tradeoffs**:
- The team operates InsForge, the Docker host, backups, and upgrades. There is no managed platform to lean on.
- Open Nile Portal and Moodle sessions survive the end of a booking until those systems' own timeouts. Only the VMs get a hard cut.
- The app reads InsForge's Postgres directly, so an InsForge upgrade that changes its database layout or access could affect the app. Pin the InsForge version and test before upgrading.
- The reconciler makes Authentik API calls every 30 seconds (one membership read per testbed). That is fine at this scale, but it grows with the testbed count.
- A single worker replica is a single point of delay: if it is down, access changes and emails wait until it is back (nothing is lost).
- Several integration facts are unconfirmed (see Follow-up) and must be proven before later features rely on them.
- The owner must bind each new pod group to its Authentik applications by hand, so a new testbed is not fully live until that manual step is done.

**Neutral**:
- `proxy.ts` (not `middleware.ts`) is the Next.js 16 convention.
- The InsForge SDK stays available but unused. If an InsForge feature beyond Postgres (storage, functions) is ever needed, add it then.
- The InsForge skills are installed user wide. The project relies on them being present for whoever builds.

## Follow-up

- [ ] **Spikes before the scaffold** (highest risk first; each is a short throwaway check, and if one fails, return to `/architect`): (1) direct `pg` login to InsForge's Postgres as a custom role, `btree_gist` available, the `app`/`auth` schemas not exposed by InsForge's REST layer, and whether the InsForge CLI can apply SQL migrations to self host (else use Kysely `Migrator`); (2) Authentik: delete a user's authenticated sessions via the API, and a SAML property mapping emitting `NileAdministrators-<x>` from `pod-<x>`; (3) Cloudflare: Access revoke for a single user (and how to look them up by email) ends an already open browser rendered session, an Access policy matching the Authentik `groups` claim, and whether browser rendered **RDP** is GA (if it is not, Windows VMs fall back to the 1 hour session as their only cut off); (4) Better Auth `genericOAuth` with DB sessions on Next.js 16 against Authentik.
- [ ] Pin an Authentik version without the recovery link HTTP 405 bug reported against 2026.5.6 (the set password email depends on the recovery link API).
- [ ] Feature 3 (data model): model "one Upcoming/Current booking per learner" without a `now()` based index; include the `jobs`, rate limit, encrypted integration secret (Gmail refresh token), and email send status tables, the booking `version` for ICS `SEQUENCE`, the calendar event id, and the `provisioning` booking state.
- [ ] Feature 4 (Authentik sign in): admin role recognition from the groups claim, the provisioning service account's RBAC role, and the fallback if RBAC cannot stop it from touching admins (the `pod-*` guard and the admin refusal in the saga are the floor).
- [ ] Feature 17 (reminders): decide where the reminder lead time is configured.
- [ ] Scope (`/scope`): (a) reword the access termination rule and feature 14's done line to "open VM sessions are cut off at once; Nile Portal and Moodle block new sign ins at once and open sessions end at their own short timeout"; (b) enroll **admin reschedule**; (c) note on features 10 and 15 the admin visibility picks (email send status in the console, the shared "HOL bookings" calendar, the ops BCC); (d) feature 9's "protects its URLs" now means "creates the pod group; the owner binds it to the Authentik applications"; (e) feature 16's set password email is sent by the app via Gmail.
- [ ] Owner runbook (outside code): Nile SAML providers and the shared mapping, a short Nile session timeout, Cloudflare Access apps and policies (1 hour session), Moodle `auth_oidc` and a short Moodle session timeout, the Google OAuth client (dev) and Workspace domain wide delegation plus SPF/DKIM (prod), the Cloudflare API token, and a **nightly `pg_dump`** of InsForge's Postgres to off host storage, with a named owner.
- [ ] Root `AGENTS.md` should record this stack, the repo layout, and the build invariants (feature 2, `/audit`).
- [ ] `AGENTS.md` `## Agent skills` should list the seven project skills installed in this run (root: shadcn, tailwind-design-system, zod, vitest, playwright-cli, playwright-best-practices; the auth area's nested `AGENTS.md`: better-auth-best-practices), plus an `MCP servers:` line once connected.
- [ ] Engineer connects the chosen MCP servers (`claude mcp add`): Better Auth docs (`https://mcp.better-auth.com/mcp`), Playwright MCP, and the community Authentik MCP (`Samik081/mcp-authentik`), pointed **only at the local dev Authentik**, never at production.
