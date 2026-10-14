# 0012. Lab access and booking result screens

**Date**: 2026-10-14 (updated 2026-10-14 after spike 3)
**Status**: In Progress

## Summary

Learners see their testbed's Nile Portal, LMS course, and client links in three places: the booking success screen, the reschedule success screen, and a new reservation detail page at `/reservations/<id>`. The links appear only when a signed in session proves the learner owns the booking. A guest who is not signed in gets a short line saying where the links will be. On a Past booking the links turn into plain "Ended" text. On the access side, learners reach the lab VMs through a dedicated Authentik app, HOL Labs, which Cloudflare Access uses as its login; each VM's Cloudflare policy admits only the testbed's `pod-<slug>` group. The existing worker keeps adding and removing those group members on the booking clock, and now also calls Cloudflare Access revoke after each removal, using a Cloudflare token the owner stores once on the admin API Keys page. In spike 3 the revoke closed an open VNC session about 40 seconds after the call.

## Requirements

**User stories**:
- As a signed in learner, I want my lab links on the success screen and on my reservation's page, so I can open the lab without searching my email.
- As a learner whose booking has ended, I want to see which testbed I had while knowing the links no longer work, so I can quote it to support.
- As the owner, I want lab links shown only to the learner who owns the booking, and an open VM session cut off when the booking ends, so the labs are never left open to the wrong person.
- As the owner, I want to store and rotate the Cloudflare token in the admin console, so the worker picks it up without a redeploy and the token never sits in a file I have to copy around.

**Acceptance criteria**:
- **AC-1**: `ownLabAccess(conn, userId, bookingId)` returns a booking's lab access (testbed name, lab type name, `status`, `startsAt`, `endsAt`, Nile Portal URL, LMS URL, and each client's name, kind, and URL in `position` order) only when all of these hold: the id is a uuid, `bookings.user_id = userId`, the booking `status` is `confirmed` or `completed`, and the user is a learner who is `active` with `email_verified_at` set. Anything else returns `missing`. The query names its columns explicitly and never selects `os_username` or `os_password`.
- **AC-2**: When the `bookAction` caller is a signed in active learner (`sessionAccount`) and the booked user is that same learner, the `booked` reply carries `access` (the AC-1 links), and the success card (spec 0010 AC-10) shows a "Your lab access" card below the existing "View my reservations" line (which stays). If the post commit `ownLabAccess` read returns `missing` or throws, the reply still is `booked` with `access: null`, and the card is left out. The card has one row each for "Nile Portal", "LMS course", and every client as "<name> · <kind>", each with an "Open" link (`target="_blank"`, `rel="noopener noreferrer"`, an external link icon), and the note "These links start working at your start time (allow up to a minute)."
- **AC-3**: A caller who is not signed in never receives lab links: the `booked` reply carries `access: null`, and the serialized reply contains no portal, LMS, or client URL. For a reused account (`newUser: false`), the existing sign in line reads "Sign in with your existing credentials anytime to manage this reservation. Your lab access shows there once your lab starts." followed by the "Manage my reservations" link.
- **AC-4**: For a new learner (`newUser: true`), the success screen keeps the "Set your password" box from spec 0010 AC-10 and adds the line "After you set your password, sign in to Manage my reservation. Your lab access shows there once your lab starts." It shows no lab access card.
- **AC-5**: The reschedule success screen (spec 0011 AC-11) shows the same lab access card as AC-2 for the moved booking. Its links come from `ownLabAccess` after the transaction commits, so they belong to the newly assigned testbed if the move changed it. If that read returns `missing` or throws (caught, logged), the reply is still `rescheduled` with `access: null`, the card is left out, and the rest of the screen renders.
- **AC-6**: On `/reservations` each card gains "View lab access" (a link to `/reservations/<id>`, outline small button). The order follows the mock: a Current card shows Reschedule (when reschedulable), View lab access, then Cancel reservation; a Past card shows View lab access only; an Upcoming card gets nothing new.
- **AC-7**: `/reservations/[id]` calls `requireLearner()` and renders `notFound()` whenever `ownLabAccess` returns `missing` (malformed id, unknown id, another learner's booking, a cancelled or provisioning booking). Otherwise it shows, in order: a "← All reservations" link to `/reservations`; the testbed name as `h1` with the phase badge (`toneFor`); rows Lab type, Starts, Ends in `users.timezone`; then a "Lab access" card with its note, a "Testbed assigned" row, and the AC-2 link rows. The note by phase: Current, "Quote the testbed name below if you contact support. Access can take up to a minute to start after your start time."; Upcoming (reachable by URL only, not linked from the list), "These links start working at your start time (allow up to a minute). Quote the testbed name below if you contact support." The page title is "Lab access", and the page keeps the default `noindex`.
- **AC-8**: On a Past booking's detail page the note reads "This reservation has ended and access is no longer active. Quote the testbed name below if you contact support." Each link row keeps its label but shows a plain "Ended" tag in place of "Open": no anchor, no `href` in the DOM, nothing focusable. The page passes the card only labels and client kinds for a Past booking, so no portal, LMS, or client URL reaches the browser in the HTML or the page payload. The tag's text and background are a token pair registered in `tests/design-contrast.test.ts` (AA). The card is never faded with opacity.
- **AC-9**: Access follows the booking window through the existing reconciler (spec 0004 AC-12, unchanged): a learner is in `pod-<slug>` only while their confirmed booking on that testbed is Current by the DB clock. They are added within one tick (about 30 seconds) of the start. Booking end, cancel (learner or admin), reschedule off that testbed or out of the window, and deactivation each remove them within one tick, and every removal ends their Authentik sessions. A learner reaches a testbed's VM URLs only through the HOL Labs Authentik app (spec 0003 AC-19): HOL Labs admits a learner only while they are in some `pod-*` group, and the VM's Cloudflare Access app accepts only the HOL Labs login method with a policy requiring `pod-<slug>` in the `groups` claim (owner setup, see Configuration required). So a learner in `pod-<slug>` opens that testbed's VMs, a learner in no `pod-*` group is refused by Authentik, and a learner in another testbed's group is refused by Cloudflare. Nile Portal and Moodle refuse new sign ins at once, and an already open session there ends at that system's own short timeout (spec 0001, accepted by the owner).
- **AC-10**: When Cloudflare revoke is on (AC-11), each successful group removal runs, in this order: end the learner's Authentik sessions, then the Cloudflare Access revoke for the learner's `users.email` sent exactly as stored (the value the saga wrote to Authentik, so it matches the `email` claim Cloudflare holds; run even when ending sessions failed), then the AC-12 audit row. The revoke is `POST {base URL}/access/organizations/revoke_user` with JSON `{ "email": "<email>" }` and `Authorization: Bearer <token>` (the base URL and token from AC-11); a 2xx reply parsed with Zod as `{ success: true }` is `done`. It makes up to 3 tries (the first at once, the second 2 seconds after the first fails, the third 5 seconds after the second fails) with a 5 second timeout on each. A try that ends in a 429, a 5xx, a timeout, or a network error is followed by the next try; any other reply is final for that learner. The breaker trips on a 401 or 403 (bad configuration) or when all 3 tries end `unavailable`; after it trips, every later revoke in the same reconciler run is recorded as `failed` without a call, while session ends and audit rows still happen. Any other 4xx is `failed` for that learner only. A pk with no `users` row (so no email) is `failed` with no call and does not trip the breaker. A failure logs a console error naming the user id (or the pk), never the email, the token, the request URL, or the response body. Spike 3 measured the effect: new requests to the VM are refused within about 5 seconds and an open VNC stream is closed within about 40 seconds of a `done` revoke. The Access session duration stays the backstop for a `failed` one.
- **AC-11**: The Cloudflare credentials come from the one live API key of type `CLOUDFLARE` (spec 0006 AC-12): its base URL is `https://api.cloudflare.com/client/v4/accounts/<account id>` and its secret is the API token. At the start of each `reconcileAccess` run the worker calls `cloudflareRevokeConfig(conn, keyring)` in `server/catalog/api-keys.ts`, which answers `off` (no live `CLOUDFLARE` key), `broken` (the keyring is missing or invalid, or the secret does not decrypt), or `on` with `{ baseUrl, apiToken }`. `off` skips every revoke (outcome `off`). `broken` records every revoke in that run as `failed` with no call, and a run that had at least one removal logs one console error ("Cloudflare revoke key can't be read", no detail); a run with no removals logs nothing. `cloudflareRevokeConfig` catches any error from the keyring getter, the read, or the decrypt and answers `broken`; it never throws. `on` builds the AC-10 revoker for that run, so a rotated token takes effect on the next tick with no restart. A run already in progress when the key is edited or deleted finishes with the token it read; the next run reads again. The worker reads the keyring through `encryptionEnv()` only when a live `CLOUDFLARE` key exists. It logs "Cloudflare VM revoke is on", "is off", or "is broken" on the first run and again only when the state changes: `worker/index.ts` keeps `let lastRevokeKind` beside `lastPurge`, the revoke source it passes to `reconcileAccess` records each run's kind there, and the pure `revokeStateLine(prev, next)` returns the line or `null` (no module variable). A missed line when a run times out is acceptable. The token is decrypted only in the worker; the web process sees it only in the admin save request that encrypts it (spec 0006 AC-12). The token never appears in a log, an error, or audit metadata. No `CLOUDFLARE_*` env var exists.
- **AC-12**: The `access.revoked` audit row is written last, after the session end and the revoke (today it is written before the session end; this moves it). Its metadata gains `sessionsEnded` (`endAuthentikSessions(...).ok`) and `vmRevoke` (`'done' | 'failed' | 'off'`). A removal that fails still ends no sessions, makes no revoke call, and writes no audit row. There is no new `AuditAction` value.

## Decision

**Chosen option**: Option 1: links gated on a session that owns the booking, through one shared server read; an inline Cloudflare revoke in the reconciler, configured through a `CLOUDFLARE` API key; and VM access through a dedicated HOL Labs Authentik app.

Every screen that shows lab links gets them from `ownLabAccess`, filtered by the session learner. The reconciler stays the only owner of access and gains a bounded, best effort Cloudflare Access revoke after each removal. Learners sign in to the VMs through HOL Labs, so the learner isolation of spec 0003 stays closed on every other app, and each VM's Cloudflare policy checks the testbed's `pod-<slug>` group.

**Implementation skills**: `kysely` (`mindrally/skills`, `.claude/skills/kysely/`) · `zod` (`pproenca/dot-skills`, `.claude/skills/zod/`) · `shadcn` (`shadcn-ui/ui`, `.claude/skills/shadcn/`) · `shadcn-baseui` (`thunderboltdev/shadcn-baseui`, `.claude/skills/shadcn-baseui/`) · `supabase-postgres-best-practices` (`supabase/agent-skills`, `.claude/skills/supabase-postgres-best-practices/`) · `vitest` (`antfu/skills`, `.claude/skills/vitest/`) · `playwright-best-practices` (`currents-dev/playwright-best-practices-skill`, `.claude/skills/playwright-best-practices/`)

## Rationale

Reasoning, options, and the spike 3 evidence: see [rationale.md](rationale.md).

## Feature design

### Data model sketch

One small migration, `0008_cloudflare_api_key.sql` (the screens need none):

| Table | Change |
|---|---|
| `api_keys` | `api_keys_type_check` becomes `type in ('IDP', 'AI', 'CLOUDFLARE')`; new partial unique index `api_keys_one_cloudflare_uq on (type) where type = 'CLOUDFLARE' and deleted_at is null` (at most one live Cloudflare key; the name is a contract with `mapConstraintError`) |

`ApiKeyType` in `lib/db-enums.ts` gains `CLOUDFLARE` (the `checkLists` parity test covers it), and `server/db/types.ts` is regenerated.

Read only, as before:

| Table | Used for | Access |
|---|---|---|
| `bookings` | ownership (`user_id`), `status`, `starts_at`, `ends_at`, `testbed_id`, `testbed_type_id` | read |
| `testbeds` | `name`, `portal_url`, `lms_url` (https only, `HttpsUrl` in `lib/catalog-input.ts`) | read |
| `testbed_clients` | `name`, `kind`, `url`, `position` (never `os_username`, `os_password`) | read |
| `testbed_types` | `name` | read |
| `users` | `role`, `status`, `email_verified_at`, `timezone`; `email` for the revoke | read |
| `api_keys` | the live `CLOUDFLARE` row: `base_url`, `secret_ciphertext` (worker only) | read |
| `audit_events` | `access.revoked` metadata gains `sessionsEnded`, `vmRevoke` | insert (existing write, moved) |

No new `AuditAction`, `JobKind`, or env var.

Authentik objects (spec 0003 AC-19, created by hand on 2026-10-14 and to be owned by the setup script): the `hol-labs` application and its "HOL Labs" OAuth2 provider, the `hol-lab-authorization` flow, and the `hol-labs-access` policy bound to the application.

### State transitions

No new states. The phase comes from `bookingPhase` (`lib/booking-phase.ts`) at `dbNow()`: Upcoming → Current → Past. Group membership is unchanged (spec 0004): not a member → member when Current → not a member at end or cancel. Removal now also triggers the revoke: removed → sessions ended → VM revoke (`done` | `failed` | `off`) → audit row. The revoke source per run: `off` | `broken` | `on`.

### API surface

| Surface | Kind | Inputs | Outputs | Auth | Key errors |
|---|---|---|---|---|---|
| `ownLabAccess(conn, userId, bookingId)` in `server/booking/lab-access.ts` | server read | session user id, booking id | `{ kind: 'ok', access: LabAccessDetail } \| { kind: 'missing' }` | caller passes the session learner id | `missing` for every miss (AC-1) |
| `bookAction` (`app/book/actions.ts`) | Server Action, public | unchanged | `booked` reply gains `access: LabLinks \| null` | public allow list (unchanged); links only for a session owner | none new |
| `rescheduleAction` (`app/reservations/[id]/reschedule/actions.ts`) | Server Action | unchanged | `rescheduled` reply gains `access: LabLinks \| null` | `requireLearner()` (unchanged) | none new |
| `/reservations/[id]` (`app/reservations/[id]/page.tsx`) | page | `params.id` | the AC-7 page | `requireLearner()` | `notFound()` on `missing` |
| `revokeAccessUser(config, email)` in `server/cloudflare/access.ts` | outbound HTTP, one call | `CloudflareConfig = { baseUrl, apiToken }`, email | `Result<void, 'unavailable' \| 'config' \| 'rejected'>` | Cloudflare API token (Bearer) | `unavailable` (429, 5xx, timeout, network; retryable), `config` (401, 403), `rejected` (any other non success) |
| `makeRevoker(config, { sleep })` in `server/cloudflare/access.ts` | factory, called once per `reconcileAccess` run when the source is `on` | config, an injected `sleep` | `VmRevoker = (email: string \| null) => Promise<'done' \| 'failed'>`, owning the AC-10 retries and breaker in its own closure | none | never throws |
| `verifyCloudflareToken(config)` in `server/cloudflare/access.ts` | outbound HTTP, save time only | `{ baseUrl, apiToken }` | `Result<void, 'invalid' \| 'unavailable'>` | the typed token | `invalid` (any 4xx, or a 2xx without `success: true`), `unavailable` (timeout, network, 5xx) |
| `cloudflareRevokeConfig(conn, keyring)` in `server/catalog/api-keys.ts` | worker read | conn, a lazy keyring getter | `{ kind: 'off' } \| { kind: 'broken' } \| { kind: 'on', config: CloudflareConfig }` | worker only | never throws |
| `reconcileAccess(api, conn, revokeSource)` (`server/worker/reconcile.ts`) | worker step | `revokeSource: () => Promise<RevokeSource>`, called once at the start of each run | void | provisioning token, Cloudflare token | per group try and log (unchanged) |

Shared types in `lib/lab-access.ts` (safe on both sides): `LabLinks = { portalUrl, lmsUrl, clients: readonly { name, kind: ClientKind, url }[] }`, `LabAccessDetail = { testbedName, typeName, status: 'confirmed' | 'completed', startsAt: Date, endsAt: Date, links: LabLinks }`, plus the pure `labAccessView(phase)` → `{ note, active }` used by the card. For a Past booking the page maps `links` to `{ label, kind }` rows only before rendering (AC-8).

`CloudflareConfig` moves from `server/env.ts` to `server/cloudflare/access.ts` and carries the base URL instead of a bare account id, so the revoke path is the base URL plus `/access/organizations/revoke_user`. `verifyCloudflareToken` calls `GET {baseUrl}/access/organizations` (a read the revoke permission includes): a 2xx parsed with Zod as `{ success: true }` is ok, which proves in one call that the token is valid, belongs to that account, and can use Access, for user and account tokens alike (checked 2026-10-14: right token and account 200, wrong account 403, malformed token 400). Its errors never carry the token, the URL, or the reply body. `RevokeOptions.baseUrl` (a test only override) is removed, because a test stub server is simply `config.baseUrl`; `timeoutMs` stays. Every call uses `fetch` with `AbortSignal.timeout(5000)` and adds no dependency.

### Value sourcing

| Action | Value produced or displayed | Source |
|---|---|---|
| `ownLabAccess` | ownership | `bookings.user_id = userId` (the session learner) |
| `ownLabAccess` | verified gate | `users.email_verified_at is not null`, `users.status = 'active'`, `users.role = 'learner'` |
| `ownLabAccess` | testbed name, portal URL, LMS URL | `testbeds.name`, `portal_url`, `lms_url` via `bookings.testbed_id` (soft deleted testbeds included, for Past) |
| `ownLabAccess` | clients | `testbed_clients.name`, `kind`, `url` where `testbed_id` matches, ordered by `position` |
| `ownLabAccess` | lab type name | `testbed_types.name` via `bookings.testbed_type_id` |
| detail page | phase, badge tone | `bookingPhase({ status, startsAt, endsAt }, await dbNow(conn))`, `toneFor(phase)` |
| detail page | Starts, Ends | `formatDateTime(d, user.timezone)` with the session user's `users.timezone` |
| detail page, cards | note text, link or "Ended" | `labAccessView(phase)` |
| `/reservations` | View lab access shown | `cardActions(phase, reschedulable).viewAccess` (true for Current and Past); the page's render condition widens to `reschedule \|\| cancel \|\| viewAccess` so Past cards get their button |
| `bookAction` | `access` | `account.id === booked.value.userId` (account from `sessionAccount`, read before the saga, as today) ? `ownLabAccess(conn, account.id, booked.value.bookingId)` links : `null`; a `missing` or thrown read (caught and logged) is also `null` |
| `bookAction` | which copy (AC-3 or AC-4) | `booked.newUser` plus `access === null` |
| `rescheduleAction` | `access` | `ownLabAccess(conn, user.id, bookingId)` after `rescheduleOwnBooking` returns ok |
| success cards | note | the fixed Upcoming note (a booked or rescheduled start is always at least `LEAD_MS`, one hour, ahead) |
| reconciler | email to revoke | `users.email`, looked up by `authentik_user_pk` (extend the existing lookup that feeds the audit row to also select `email`); no row means `null`, which the revoker records as `failed` with no call |
| reconciler | `sessionsEnded` | `endAuthentikSessions(api, pk).ok` |
| reconciler | `vmRevoke` | `'off'` when the run's source is `off`; `'failed'` for every removal when it is `broken`; else `done` or `failed` from the AC-10 retry |
| `cloudflareRevokeConfig` | base URL | `api_keys.base_url` of the one live `CLOUDFLARE` row (`api_keys_one_cloudflare_uq`) |
| `cloudflareRevokeConfig` | API token | `decryptSecret(keyring, secret_ciphertext, secretAad("api_keys", "secret_ciphertext", id))`, the keyring from `encryptionEnv().keyring` read only when that row exists |
| worker | revoke state log line | `revokeStateLine(lastRevokeKind, kind)`, `lastRevokeKind` held in `worker/index.ts` |
| admin save | Cloudflare check result | `verifyCloudflareToken({ baseUrl: input.baseUrl, apiToken: input.secret })`, run before the write transaction, only when a key value is typed on a `CLOUDFLARE` key (spec 0006 AC-12) |

### Key invariants

- Lab links leave the server only for a session learner who owns the booking and is verified (AC-1). No public reply ever carries them (AC-3).
- `ownLabAccess` is the only read that returns lab links to a learner. It never selects client OS credentials (spec 0007; `tests/os-password-scan.test.ts` still allows `os_password` only in `server/catalog/testbeds.ts`).
- The reconciler stays the only code that adds or removes `pod-*` members, and the only caller of the Cloudflare revoke.
- The revoke runs only after a successful removal. The retry state (the breaker) is local to one `reconcileAccess` run (built per call), never a module variable. The revoke source is read once per run.
- At most one live `CLOUDFLARE` API key exists (`api_keys_one_cloudflare_uq`). `secret_ciphertext` still appears in app code only in `server/catalog/api-keys.ts` (`tests/secret-column-scan.test.ts`), so the decrypt for the worker lives there too.
- A Cloudflare VM app must accept only the HOL Labs login method and must require its testbed's `pod-<slug>` claim. HOL Labs admits any learner in any `pod-*` group, so an app that allowed "everyone on HOL Labs" would open that VM to every learner with a Current booking anywhere. This is owner configuration in Cloudflare; `verify.md` checks it per VM.
- Worst case per run in a Cloudflare outage: one revoke's 3 tries (about 22 seconds) and then no more calls, so the step stays well inside `STEP_TIMEOUT_MS` (60 seconds).
- Past links are never rendered as anchors, and Past URLs never leave the server (AC-8).
- Accepted, not fixed: if a reconciler step overruns its timeout, the next run can overlap it and remove, revoke, and audit the same learner twice (harmless, since revoke and session end are idempotent). A learner removed from one group while Current on another in the same run can't happen, because of the one active booking rule and the one hour lead time on any new start. A signed in session whose `email_verified_at` is somehow null makes `ownLabAccess` return `missing`, so the card is simply left out; do not "fix" this by trusting the session alone.
- Accepted, not fixed: right after a revoke, Cloudflare refuses that email's fresh sign ins ("Current authentication token is expired") for under about 2 minutes (spike 3). Every new start is at least an hour after any booking change, so no learner meets it.
- `/reservations/[id]` is dynamic because `requireLearner()` reads cookies. Never add `generateStaticParams` or a cache directive to it. The existing `/reservations/[id]/reschedule` page under the same segment keeps its own behavior.

### Security model

- Detail page: `requireLearner()`, then `ownLabAccess` filtered by the session user. Another learner's id behaves exactly like an unknown id (`notFound()`), so ids can't be probed.
- `bookAction` stays public. Identity for links comes only from the session (`sessionAccount`), never from the posted email (the AGENTS.md rule for signed in learners on `/book`).
- Links open with `rel="noopener noreferrer"`, so the lab site gets no `window.opener` and no Referer carrying the booking id. Stored URLs are https only (spec 0007).
- Client OS usernames and passwords never reach these screens (engineer call 2026-10-10, spec 0007 Follow-up). They go only in the booking email (feature 15).
- VM access has two gates. Authentik's HOL Labs app admits learners only while they are in a `pod-*` group (and admits staff and admins, who are off `hol/learners`); Cloudflare's per VM policy admits only the matching `pod-<slug>`. Learners stay refused on `cloudflare-integration` and every other app (spec 0003 AC-17).
- Cloudflare token: typed once by an admin on the API Keys page, checked with Cloudflare from the web process during that save (the only outbound call the web process makes with it), encrypted with the app keyring (spec 0006), and decrypted only by the worker at the start of each reconcile run. The worker now loads the keyring, so a compromised worker host can decrypt every stored API key, not just this one; the keyring file stays mode 600 and mounted only where needed. It never reaches a browser, a log, an error, or audit metadata. Least privilege: Account → Access: Organizations, Identity Providers, and Groups → Edit, on the one account (the permission spike 3 used).
- `revoke_user` acts on the whole Cloudflare account, so it also revokes any other Access app session that learner email holds there. Learners use only HOL labs, so this is accepted.

### Configuration required

- Owner, admin console: add one API key of type `CLOUDFLARE`, base URL `https://api.cloudflare.com/client/v4/accounts/<account id>` (today `e6043d055ee10da55bd8e4b39758c681`), secret = a Cloudflare API token with Account → Access: Organizations, Identity Providers, and Groups → Edit on that account. Until it exists, revoke is `off`.
- Worker env: `APP_ENCRYPTION_KEYS_FILE` and `APP_ENCRYPTION_ACTIVE_KEY_ID` (spec 0006), now also set for the worker. Without them a live `CLOUDFLARE` key makes the revoke `broken`.
- Remove `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN_FILE` from `.env.example` and the production env.
- Owner, Cloudflare Zero Trust, once: the login method "Reservations HOL Labs" (OpenID Connect, the HOL Labs client id and secret, auth URL `…/application/o/authorize/`, token URL `…/application/o/token/`, certificate URL `…/application/o/hol-labs/jwks/`, PKCE on, OIDC claim `groups`). Done 2026-10-14.
- Owner, Cloudflare Zero Trust, per testbed: for each of the testbed's VM Access apps, login methods = only "Reservations HOL Labs" ("Accept all available identity providers" off), and one Allow policy with Include → OIDC Claims (Reservations HOL Labs) `groups` = `pod-<slug>`, where `pod-<slug>` is the testbed's read only "Access group" field in the admin console. Done for `nw4-mac1.nile.global` → `pod-nile-hol-1` on 2026-10-14.
- Owner, Authentik and Cloudflare: as each VM app moves to its `pod-*` group, empty and delete its old hand made group (`nw1` to `nw4`; `nw3` and `nw4` each still have one member who keeps VM access until then).

### Critical test scenarios

- `ownLabAccess` (DB, `inRollback`): own verified learner's Current booking returns links with clients in `position` order and no `os_` keys on any object; another learner's id, a cancelled booking, a provisioning booking, a learner with `email_verified_at` null, a deactivated learner, and a malformed id each return `missing`; a Past booking on a soft deleted testbed still returns its name and links. Verifies **AC-1**.
- `labAccessView` and `cardActions` (pure): Current and Upcoming are active with their notes, Past is inactive with the ended note; `viewAccess` is true for Current and Past only, and the Current order is Reschedule, View lab access, Cancel. Verifies **AC-6**, **AC-7**, **AC-8**.
- Success copy (component): `access` present renders the card with each "Open" link carrying `target` and `rel`; `newUser: true` renders the box and the AC-4 line with no card; `newUser: false` with `access: null` renders the AC-3 line and no card. Verifies **AC-2**, **AC-3**, **AC-4**.
- `bookAction` reply builder: no session yields `access: null` and the serialized reply contains none of the testbed's URLs, even when the email belongs to a verified learner; a matching session yields the links. Verifies **AC-2**, **AC-3**.
- Reschedule reply: a move to another testbed returns that testbed's links; a `missing` read still yields `rescheduled` with `access: null`. Verifies **AC-5**.
- Detail page auth: no session redirects through `requireLearner()`; another learner's booking id and a cancelled id render not found. Verifies **AC-7**.
- Past card (component, `renderToStaticMarkup` as in `booking-success.test.ts`): no `<a` and no `tabindex` inside the lab access card; none of the testbed's URLs appear anywhere in the markup; "Ended" tags and the ended note render; the tag's token pair is registered in `tests/design-contrast.test.ts`. Verifies **AC-8**.
- Reconciler (fake Authentik plus a fake revoke source): a removal ends sessions, then calls the revoker once with `users.email`, then writes `access.revoked` with `sessionsEnded: true, vmRevoke: 'done'`; a failed session end still revokes and records `sessionsEnded: false`; a pk with no `users` row records `failed` with no revoker call; an `off` source records `off`; a `broken` source records `failed` with no call and logs once; a failed group removal ends no sessions, makes no revoke call, and writes no audit row; the source is called once per run. Verifies **AC-10**, **AC-11**, **AC-12**.
- `makeRevoker` (an injected `sleep` that records its delays and resolves at once, and a local HTTP stub server as the base URL, no mocks): `unavailable` 3 times gives `failed` after delays of 2000 and 5000 ms, and the next call in the same revoker makes no request and gives `failed`; a 403 gives `failed` with no retry and trips the breaker; a 400 gives `failed` for that learner only, and the next call still goes out; `null` email gives `failed` with no request. Verifies **AC-10**.
- `revokeAccessUser` (local HTTP stub server): 2xx with `success: true` is ok; 429, 503, and a timeout are `unavailable`; 401 and 403 are `config`; 400 is `rejected`; the request goes to `{baseUrl}/access/organizations/revoke_user`; no error string or captured log line contains the token, the email, or the request URL. Verifies **AC-10**, **AC-11**.
- `cloudflareRevokeConfig` (DB, `inRollback`, an in memory keyring): no live `CLOUDFLARE` key is `off` and never reads the keyring; a live key round trips to `on` with its base URL and token; a keyring getter that throws, or a ciphertext under an unknown key id, is `broken`; a soft deleted key is `off`. Verifies **AC-11**.
- Worker state log (pure): `revokeStateLine` over `undefined → off → on → on → broken` gives exactly three lines; no `CLOUDFLARE_*` read anywhere (a source scan). Verifies **AC-11**.
- `verifyCloudflareToken` (local HTTP stub as the base URL): 200 with `success: true` is ok; 403, 400, and a 200 with `success: false` are `invalid`; 503 and a timeout are `unavailable`; the request is `GET {baseUrl}/access/organizations`; no error string contains the token or the URL. Verifies **AC-11**.
- API key rules (DB, `inRollback`, a stub verifier): a second live `CLOUDFLARE` key on create or on a type change returns `cloudflare_exists`, not `duplicate_name`; a type change to or from `CLOUDFLARE`, or a base URL change on one, with the key blank is refused; a name only edit makes no Cloudflare call. Verifies **AC-11**.
- Playwright (the `learner` test account): sign in, book through signed in `/book`, and see "Your lab access" with the links under "View my reservations"; open `/reservations/<id>` directly and see the Upcoming note; the Upcoming card has no View lab access; cancel to clean up. An `afterEach` cancels any live booking the test account still holds, so a failed run never leaves it blocked by the one active booking rule on the shared database. Axe, keyboard, and screenshots on the success card and the detail page. Verifies **AC-2**, **AC-6**, **AC-7**.
- `verify.md` (manual, real Authentik and Cloudflare in `/check verify`): a booking becomes Current, and the learner is in `pod-<slug>` within a tick and the VM opens through HOL Labs; cancel it, and within a tick the membership is gone, the open VM tab stops updating within a minute, and the audit row shows `vmRevoke: 'done'`; its detail page then shows the Past state. Verifies **AC-8**, **AC-9**, **AC-10**, **AC-12**.

## Build plan

Tracer Bullet: spike 3 first (the one unknown), then a thin thread from the shared read to a real page, then thicken it: success screens, then the Cloudflare strand, then the end to end guards.

1. Spike 3 (throwaway, with the owner, on one VM's Access app). Done 2026-10-14; results in `rationale.md` under *Spike 3 evidence*. It also surfaced the HOL Labs app (spec 0003 AC-19) and the move of the token to the API Keys page. Satisfies **AC-9**, **AC-10**
2. Tracer: `lib/lab-access.ts` (`LabLinks`, `labAccessView`), `server/booking/lab-access.ts` `ownLabAccess`, the shared `components/reservations/lab-access-card.tsx` (success and detail variants, active and ended rows), the `/reservations/[id]` page, and `viewAccess` in `cardActions` with the View lab access link on Current and Past cards. Built. Satisfies **AC-1**, **AC-6**, **AC-7**, **AC-8**
3. Success screens: the `access` field on the `booked` and `rescheduled` replies, the card and the AC-3 and AC-4 copy in `booking-success.tsx`, and the card in `reschedule-success.tsx`. Built. Satisfies **AC-2**, **AC-3**, **AC-4**, **AC-5**
4. Cloudflare module: `server/cloudflare/access.ts` with `revokeAccessUser` and `makeRevoker` (built), now taking `CloudflareConfig = { baseUrl, apiToken }` (moved here from `server/env.ts`), plus `verifyCloudflareToken`. Rework: remove `cloudflareEnv()` and its call in `workerEnv()`, its tests in `server/env.test.ts`, and the two lines in `.env.example`. Built. Satisfies **AC-10**, **AC-11**
5. Cloudflare API key (spec 0006 AC-12): migration `0008_cloudflare_api_key.sql`, `db:codegen`, `ApiKeyType` gains `CLOUDFLARE`, the base URL refine in `lib/catalog-input.ts`, `onConflict` aimed at the name index and `cloudflare_exists` in `mapConstraintError`, `verifyCloudflareToken` (the Access organization probe) on save when a key value is typed, the "retype the key" rule for type and account changes, the `neutral` badge, the generalized type change check, and `cloudflareRevokeConfig` in `server/catalog/api-keys.ts`. Satisfies **AC-11**
6. Reconciler strand: the new removal order (sessions, revoke, audit), the email lookup, `sessionsEnded` and `vmRevoke` in the audit metadata, `reconcileAccess(api, conn, revokeSource)`, and the worker wiring (a revoke source built from `cloudflareRevokeConfig` with a lazy keyring getter, `lastRevokeKind` beside `lastPurge`, and the pure `revokeStateLine`). Satisfies **AC-9**, **AC-10**, **AC-11**, **AC-12**
7. Setup script (spec 0003 AC-19): `npm run authentik:setup` adopts or creates the `hol-labs` application, its provider, `hol-lab-authorization`, and `hol-labs-access` with its binding, from a new setup input `CLOUDFLARE_TEAM_DOMAIN`, and stops warning about `hol-lab-authorization` as a flow isolation does not cover. Satisfies **AC-9**
8. Guards and end to end: auth tests for the detail page, the Playwright journey with axe, keyboard, and screenshots, the HOL Labs isolation checks (spec 0003 AC-19), and `verify.md` with the manual real access steps. Satisfies **AC-2**, **AC-3**, **AC-7**, **AC-8**, **AC-9**, **AC-10**, **AC-12**

## Consequences

**Positive**:
- One read (`ownLabAccess`) decides who sees links on every screen, so the ownership rule lives in one tested place.
- Open VM sessions get a hard cut within about a minute of the booking ending, cancel, or deactivation, instead of lasting until the Access session expires (measured in spike 3).
- The owner rotates the Cloudflare token from the admin console, and the worker uses the new one on its next tick, with no file to copy and no restart.
- Learner isolation (spec 0003) stays closed on every other app; learners gain exactly one more app, and only while they hold a Current booking.

**Negative / tradeoffs**:
- A guest who is not signed in never sees links on the success screen. Until feature 15 sends the booking email, they find the links in the app only once the lab is Current (the Upcoming detail page is reachable by URL only).
- A failed revoke is not retried after its run, because the membership is already gone. That VM session then lasts until its Access session expires, visible only in the log and the audit metadata.
- During a Cloudflare outage one run spends up to about 22 seconds on retries, delaying the teardown step behind it.
- Revoke is account wide for that email (see Security model), and it briefly blocks that email's fresh sign ins (under about 2 minutes).
- Links can be refused for up to about 30 seconds after the start, until the reconciler's next tick. The note says so.
- Nile Portal and Moodle sessions already open still outlive the booking until their own timeouts (unchanged from spec 0001).
- Every new testbed needs a manual Cloudflare step by the owner (its VM apps' login method and `pod-<slug>` policy). A VM app left on "everyone on HOL Labs" would admit every booked learner; `verify.md` checks each one.
- The worker now needs the encryption keyring, and the token sits in the shared database (encrypted). Losing the keyring turns the revoke `broken` until the key is entered again.
- A migration is now part of this feature, and task 4's env work is partly undone.

**Neutral**:
- `reconcileAccess` takes a third argument, and the worker builds it.
- The audit row for a removal moves later in the removal, so a crash between removal and audit loses that row (the same risk as today, slightly longer).
- The HOL Labs Authentik objects were created by hand on 2026-10-14 so the spike could run; the setup script adopts them (task 7).

## Follow-up

- [ ] `/scope`: reword feature 14's done line as spec 0001 Follow-up (a) asked ("open VM sessions are cut off within a minute; Nile Portal and Moodle block new sign ins at once and open sessions end at their own short timeout"), note that scope line 17's "how the success screen reads before verification" is settled here (AC-3, AC-4), and note line 24's "how each URL is put behind Authentik" is settled here (HOL Labs plus a per VM Cloudflare policy on `pod-<slug>`).
- [ ] Owner: add the `CLOUDFLARE` API key in the admin console once task 5 ships, then delete `~/secrets/cloudflare_access_revoke_token` (used only by the spike).
- [ ] Owner: move every VM Access app to "Reservations HOL Labs" with its testbed's `pod-<slug>` policy, then retire `nw1` to `nw4`. Create the remaining testbeds in the app first, so their `pod-*` groups exist.
- [ ] Owner: repeat the spike 3 open session check once on a Windows RDP VM (spike 3 used a QEMU VNC session).
- [ ] A read only Cloudflare check (a script or an admin page note) that lists Access apps accepting the HOL Labs login with no `pod-*` claim rule, since one misconfigured VM app admits every learner with a Current booking. Needs a token with Access apps read permission. Until then, `verify.md` checks each VM by hand.
- [ ] Feature 18 (admin audit log): make `access.revoked` rows with `vmRevoke: 'failed'` easy to find, since a failed revoke is not retried and shows nowhere else.
- [ ] Spec 0001 image and compose work: the `worker` container now needs the keyring file mounted (not a Cloudflare token file).
- [ ] Feature 15: the booking email carries the lab links (and the client OS logins) for every learner, which covers the anonymous guests AC-3 leaves without links; it also adds Add to calendar and View email on the success screens.
- [ ] On build, close spec 0004 Follow-up "Feature 14 / spike 3", spec 0010 Follow-up "Feature 14: add the lab access card", and spec 0011 Follow-up "Feature 14: add View lab access".
- [ ] `/sync`: `server/worker/AGENTS.md` should say the reconciler also calls the Cloudflare revoke (source per run, retries and breaker); `server/authentik/AGENTS.md` should name HOL Labs as the learners' only other app; root `AGENTS.md` should name `ownLabAccess` as the only lab link read and say the `CLOUDFLARE` API key's decrypt lives in `server/catalog/api-keys.ts`.
