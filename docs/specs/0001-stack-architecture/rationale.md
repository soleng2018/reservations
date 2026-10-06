# 0001. Stack and architecture: rationale

Decision record for [index.md](index.md). `/develop` does not need this file.

## Context

Nile Hands-On Labs needs a booking app for remote lab testbeds. It has two roles (admins, learners), a guest booking flow that creates identities, and time boxed access to third party lab systems. Volume is small (a handful of testbeds, tens of bookings a day), and the team is small.

Forces that shaped the stack:

- **Identity is the product.** One self hosted Authentik, dedicated to HOL and on the company AWS instance, must sign in admins and learners of this app *and* gate every lab URL: Nile Portal tenants (SAML), Moodle, and on prem Windows/macOS VMs exposed through Cloudflare Access browser rendered RDP/VNC. The app must create learners and per testbed groups through the Authentik API, and open and close access exactly over the booking window, including cutting off sessions that are already open.
- **Owner fixed choices:** self hosted InsForge as the backend, Google for email and calendar, Next.js 16 (already scaffolded), Tailwind CSS v4, shadcn/ui.
- **Timed work is core, not a nice to have.** Access must start and stop within about a minute of booking times, reminders must fire, and failed emails must retry. Something must run on a clock.
- **Budget and hosting:** there is no Vercel Pro. Cloudflare and the company AWS instance already exist. InsForge and the lab VMs sit on prem behind Cloudflare Tunnel.
- **Secrets:** two Authentik keys of very different power, API key secrets that are written only, Google credentials, and a Cloudflare token. None may reach the browser.
- **Integrity:** no overlapping bookings per testbed and one active booking per learner, even under concurrent guests.

## Options considered

Full stacks compared (the owner fixed choices are common to all of them).

### Option 1: Self hosted Docker monolith next to InsForge (chosen)

Next.js standalone `web` plus a `worker` container from the same image, on InsForge's Docker network, published through Cloudflare Tunnel. Data goes server only, over a direct Postgres connection with real transactions. Jobs come from a DB backed queue, and lab access from a state based reconciler.

**Pros**: a full Node runtime with no platform limits · a private, low latency path to the DB · its own clock for timed jobs · no added vendor cost · matches the existing tunnel setup.
**Cons**: the team operates the host, InsForge, backups and upgrades · deploys need a registry plus a pull step.

### Option 2: Vercel + InsForge over the tunnel

Next.js on Vercel, calling InsForge and Authentik over public hostnames.

**Pros**: zero server ops · first class Next.js 16 support · preview deploys.
**Cons**: Hobby is non commercial and its cron runs daily only, so timed access needs Pro (not available) or an outside scheduler · the DB is reached over the internet through the tunnel, adding latency and an exposed InsForge endpoint · a direct Postgres connection is impractical.

### Option 3: Cloudflare Workers via OpenNext

Push to GitHub, and Cloudflare builds and runs the full app with cron triggers.

**Pros**: cheap · minute level cron · same Cloudflare account as the tunnel.
**Cons**: the Workers runtime is not full Node · the OpenNext adapter can lag new Next.js releases · the DB is still reached over the internet · SMTP style libraries are awkward there.

### Option 4: Static export on Cloudflare Pages + InsForge functions

The UI as static files, and all server logic in InsForge Deno functions.

**Pros**: the simplest frontend hosting · matches the "publish from GitHub" idea.
**Cons**: splits the app into two codebases and runtimes · puts the Authentik keys and encryption key inside InsForge functions · no Server Actions or server rendering of protected pages · InsForge self host scheduling is unconfirmed.

## Rationale

Timed access is the deciding force. Learners must be added to and removed from `pod-<testbed>` within about a minute of the booking boundaries, and open sessions must be revoked. Option 2 can't do that without paying for Pro or adding a scheduler vendor. Options 3 and 4 add runtime constraints or split the codebase to work around it. A self hosted worker next to the database (Option 1) gets a reliable clock and a private DB path for free. It also follows the owner's fallback stated during the conversation ("self hosted docker alongside InsForge").

Within Option 1, the sub decisions follow the same "fewest moving parts" logic:
- **Direct Postgres with Kysely.** Once the app sits next to InsForge, a direct connection gives real transactions. That is what booking, job leasing, and the provisioning saga need. The SDK path would have pushed all of that into SQL functions that are hard to test. InsForge still holds the data, and plain SQL migrations keep one schema definition. Constraints in the database make double booking impossible, not just unlikely.
- **A DB backed job queue** beats adding a broker at this volume. **A state based reconciler** owns lab access, because a missed one off job would leave access wrong, and the reconciler heals that on its next tick.
- **App level AES-256-GCM** keeps ciphertext opaque to InsForge without an AWS dependency on an on prem app.
- **Better Auth** was the engineer's pick over the initial suggestion of Auth.js v5 (which is in maintenance only). It is actively developed. With direct Postgres available, its DB sessions let deactivation end a session at once, which replaced the earlier stateless cookie plan.

Lab access: binding groups to Authentik applications by hand (the engineer's pick) gives the app's provisioning token the narrowest rights. That matters because the token sits in a long running process, and the `pod-*` prefix guard narrows it further in code. One `pod-<x>` group with a shared SAML mapping avoids two memberships drifting apart. Cut off is layered: group removal and Authentik session deletion everywhere, Cloudflare revoke for the VMs, and short downstream sessions for Nile and Moodle. The owner accepted that remaining gap, and the scope is to be reworded to match.

### Cross check (2026-10-04, independent Sonnet pass)

An independent read of the first draft found that the InsForge SDK path left transactions, job leasing, and the Authentik compensation without a sound home. It also found that stateless sessions could not end a deactivated or demoted user's access, that one off start/end jobs could leave access open if the worker was down, that the scope's "cut off open sessions" rule could not be met for Nile and Moodle, and about fifteen smaller gaps (migrations at deploy, local dev bootstrap, env at build time, worker bundling, saga crash recovery, the group prefix guard, client IP trust, ICS organizer, backups). The engineer chose direct Postgres + Kysely, Better Auth DB sessions, the reconciler, app sent set password emails, and a scope reword for Nile/Moodle, and approved the recommended fixes for the rest. All are reflected in `index.md`.

Google: the Gmail API in both phases keeps one send path (dev OAuth refresh token, prod service account with domain wide delegation). Building the `.ics` ourselves inside our own MIME message satisfies the scope rule of one message with the Nile template. The Calendar API is used only for an attendee free shared admin calendar, so Google never sends its own invite emails.

### Unconfirmed facts at decision time

The 2026-10-04 landscape check could not confirm the following. Each is a Follow-up to prove in the tracer bullet:
- InsForge self host: direct login to its Postgres with a custom role, which schemas its REST layer exposes, and whether its CLI applies SQL migrations to a self hosted instance. (Scheduled jobs and external OIDC for RLS are no longer needed.)
- Authentik: RBAC exclusion of admin users for a token, the authenticated sessions delete call, whether deactivation ends sessions, and SAML group name transformation in property mappings. A recovery link HTTP 405 bug was reported in 2026.5.6.
- Cloudflare Access: matching the OIDC groups claim in policies, the revoke user API, and whether revoke ends an open browser rendered session. Browser rendered VNC is GA. Browser rendered RDP was announced, with its GA status unconfirmed.
- Confirmed via the installed `better-auth-best-practices` skill: the `genericOAuth` plugin and database adapters (stateless mode also exists but was not chosen).

## References

**Project sources**
- `docs/scope/scope.md`: owner decisions (Authentik, the two keys, the guest flow, timed access, email templates, write only secrets).
- `context/reservations_mock.html`, `context/Nile HOL Lab Access Email Standalone.html`, `context/Nile HOL Cancellation Email Standalone.html`.
- `node_modules/next/dist/docs/`: Next.js 16 `proxy.ts` and `output: 'standalone'`.
- Installed skills: `insforge`, `insforge-cli`, `better-auth-best-practices`.
- `docs/.agent-cache/research/stack-architecture.md` and `docs/.agent-cache/tool-discovery/stack-architecture.md`: the landscape and tool checks run on 2026-10-04.

**Practices & standards**
- Monolith first. A database backed queue before a broker.
- Enforce invariants in the database (exclusion constraints) rather than only in app code.
- A persisted saga with a sweeper for multi system writes.
- Level triggered reconciliation (desired state vs actual state) over edge triggered jobs for access control.
- Least privilege service tokens. Keep the master credential out of runtime processes.
- Envelope style versioned ciphertext for key rotation.

**Links** (web verified 2026-10-04)
- InsForge repository: https://github.com/InsForge/InsForge
- Authentik service accounts: https://docs.goauthentik.io/sys-mgmt/service-accounts/
- Authentik recovery email API: https://docs.goauthentik.io/docs/developer-docs/api/reference/core-users-recovery-email-create
- Authentik authenticated sessions API: https://api.goauthentik.io/reference/core-authenticated-sessions-list/
- Authentik recovery 405 issue: https://github.com/goauthentik/authentik/issues/24869
- Cloudflare browser rendering for non HTTP apps: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/non-http/browser-rendering/
- Cloudflare browser based RDP: https://blog.cloudflare.com/browser-based-rdp/

## Evidence: spike 1, direct Postgres on self hosted InsForge (2026-10-05)

### Results

| Question | Result |
|---|---|
| Direct `pg` login as a custom role | **Pass.** Non-superuser login role with scram password works from the host (`127.0.0.1:5432`) and from a container on `hol-internal` (`insforge-postgres:5432`). Wrong password is refused; `postgres` has no passwordless access from outside the container (`trust` is container-loopback only). |
| `btree_gist` | **Pass.** v1.7 available. A `exclude using gist (testbed_id with =, during with &&)` constraint on `tstzrange` rejected an overlapping booking and allowed adjacent `[)` ranges. It must be created by `postgres` (the app role lacks CREATE on the database). |
| Isolation of the app role | **Pass.** No access to InsForge's `auth`, `system`, or `public` schemas; cannot create schemas or extensions. |
| `app`/`auth` not exposed by InsForge REST | **Partial.** InsForge's event trigger `insforge_sync_postgrest_schemas` (`system.sync_postgrest_exposed_schemas`) auto-adds **every new schema** to PostgREST's `pgrst.db_schemas`, overriding `PGRST_DB_SCHEMA=public`. Our schemas were still unreadable (`anon`/`authenticated`/`project_admin` have no USAGE, so "permission denied"). Adding them to the database setting `insforge.internal_schemas` removes them from PostgREST entirely (PGRST106 via both PostgREST and InsForge's `/api/database/records` with the anon key). |
| InsForge CLI applies SQL migrations to self-host | **Yes, but unsuitable.** `insforge link --api-base-url --api-key` + `db migrations up` works against OSS, but executes as `project_admin` through the InsForge API (needs the admin `ik_` key at deploy time) and cannot touch schemas owned by the app role. **Use Kysely `Migrator` as the app role.** |

### Consequences for spec 0001 (for `/architect`)

1. **Schema name clash:** InsForge already owns a schema named `auth`. Better Auth's tables need another name (e.g. `hol_auth`); `app` is free but `hol_app` as a schema name pairs well with the role.
2. **One-time bootstrap as `postgres`** (not a migration): create the login role, create the app schemas owned by it, `revoke all ... from public`, `create extension btree_gist`, and set `alter database insforge set insforge.internal_schemas = '<InsForge default list>,<our schemas>'`. That setting replaces InsForge's default list, so re-check it on every InsForge upgrade (a new internal schema upstream would otherwise become exposed).
3. **Defense in depth stays:** no grants to `anon`/`authenticated`/`project_admin` on our schemas, plus RLS-with-no-policies, regardless of the exclusion setting.
4. **Migrations:** Kysely `Migrator` reading `db/migrations/*.sql`, run by the `migrate` service as the app role. Drop the InsForge CLI option.
5. **Environment gaps found:** Node is not installed on this host (dev needs Node 24, e.g. via nvm), and the `insforge`/`insforge-cli`/`insforge-debug` skills the spec says are installed user-wide are not present.
6. **Authentik (superseded, see correction below):** the Authentik in use is the shared lab instance 2025.6.4 on this host (`authentik.nile.global`), not a dedicated AWS one.

*Correction (owner, 2026-10-05): the lab Authentik only guards the InsForge dashboard. The app uses the dedicated AWS Authentik (`authentik.dev.app.nile-global.cloud`) for dev and production, as the spec says. Node 24 is now installed via nvm.*
