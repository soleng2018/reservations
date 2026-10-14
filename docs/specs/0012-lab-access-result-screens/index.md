# 0012. Lab access and booking result screens

**Date**: 2026-10-14
**Status**: In Progress

## Summary

Learners see their testbed's Nile Portal, LMS course, and client links in three places: the booking success screen, the reschedule success screen, and a new reservation detail page at `/reservations/<id>`. The links appear only when a signed in session proves the learner owns the booking. A guest who is not signed in gets a short line saying where the links will be. On a Past booking the links turn into plain "Ended" text. On the access side, the existing worker keeps adding and removing group members on the booking clock, and it now also calls Cloudflare Access revoke after each removal, so an open browser VM session is cut off right away instead of running on for up to an hour.

## Requirements

**User stories**:
- As a signed in learner, I want my lab links on the success screen and on my reservation's page, so I can open the lab without searching my email.
- As a learner whose booking has ended, I want to see which testbed I had while knowing the links no longer work, so I can quote it to support.
- As the owner, I want lab links shown only to the learner who owns the booking, and an open VM session cut off when the booking ends, so the labs are never left open to the wrong person.

**Acceptance criteria**:
- **AC-1**: `ownLabAccess(conn, userId, bookingId)` returns a booking's lab access (testbed name, lab type name, `status`, `startsAt`, `endsAt`, Nile Portal URL, LMS URL, and each client's name, kind, and URL in `position` order) only when all of these hold: the id is a uuid, `bookings.user_id = userId`, the booking `status` is `confirmed` or `completed`, and the user is a learner who is `active` with `email_verified_at` set. Anything else returns `missing`. The query names its columns explicitly and never selects `os_username` or `os_password`.
- **AC-2**: When the `bookAction` caller is a signed in active learner (`sessionAccount`) and the booked user is that same learner, the `booked` reply carries `access` (the AC-1 links), and the success card (spec 0010 AC-10) shows a "Your lab access" card below the existing "View my reservations" line (which stays). If the post commit `ownLabAccess` read returns `missing` or throws, the reply still is `booked` with `access: null`, and the card is left out. The card has one row each for "Nile Portal", "LMS course", and every client as "<name> · <kind>", each with an "Open" link (`target="_blank"`, `rel="noopener noreferrer"`, an external link icon), and the note "These links start working at your start time (allow up to a minute)."
- **AC-3**: A caller who is not signed in never receives lab links: the `booked` reply carries `access: null`, and the serialized reply contains no portal, LMS, or client URL. For a reused account (`newUser: false`), the existing sign in line reads "Sign in with your existing credentials anytime to manage this reservation. Your lab access shows there once your lab starts." followed by the "Manage my reservations" link.
- **AC-4**: For a new learner (`newUser: true`), the success screen keeps the "Set your password" box from spec 0010 AC-10 and adds the line "After you set your password, sign in to Manage my reservation. Your lab access shows there once your lab starts." It shows no lab access card.
- **AC-5**: The reschedule success screen (spec 0011 AC-11) shows the same lab access card as AC-2 for the moved booking. Its links come from `ownLabAccess` after the transaction commits, so they belong to the newly assigned testbed if the move changed it. If that read returns `missing` or throws (caught, logged), the reply is still `rescheduled` with `access: null`, the card is left out, and the rest of the screen renders.
- **AC-6**: On `/reservations` each card gains "View lab access" (a link to `/reservations/<id>`, outline small button). The order follows the mock: a Current card shows Reschedule (when reschedulable), View lab access, then Cancel reservation; a Past card shows View lab access only; an Upcoming card gets nothing new.
- **AC-7**: `/reservations/[id]` calls `requireLearner()` and renders `notFound()` whenever `ownLabAccess` returns `missing` (malformed id, unknown id, another learner's booking, a cancelled or provisioning booking). Otherwise it shows, in order: a "← All reservations" link to `/reservations`; the testbed name as `h1` with the phase badge (`toneFor`); rows Lab type, Starts, Ends in `users.timezone`; then a "Lab access" card with its note, a "Testbed assigned" row, and the AC-2 link rows. The note by phase: Current, "Quote the testbed name below if you contact support. Access can take up to a minute to start after your start time."; Upcoming (reachable by URL only, not linked from the list), "These links start working at your start time (allow up to a minute). Quote the testbed name below if you contact support." The page title is "Lab access", and the page keeps the default `noindex`.
- **AC-8**: On a Past booking's detail page the note reads "This reservation has ended and access is no longer active. Quote the testbed name below if you contact support." Each link row keeps its label but shows a plain "Ended" tag in place of "Open": no anchor, no `href` in the DOM, nothing focusable. The page passes the card only labels and client kinds for a Past booking, so no portal, LMS, or client URL reaches the browser in the HTML or the page payload. The tag's text and background are a token pair registered in `tests/design-contrast.test.ts` (AA). The card is never faded with opacity.
- **AC-9**: Access follows the booking window through the existing reconciler (spec 0004 AC-12, unchanged): a learner is in `pod-<slug>` only while their confirmed booking on that testbed is Current by the DB clock. They are added within one tick (about 30 seconds) of the start. Booking end, cancel (learner or admin), reschedule off that testbed or out of the window, and deactivation each remove them within one tick, and every removal ends their Authentik sessions. Nile Portal and Moodle refuse new sign ins at once, and an already open session there ends at that system's own short timeout (spec 0001, accepted by the owner).
- **AC-10**: When Cloudflare is configured (AC-11), each successful group removal runs, in this order: end the learner's Authentik sessions, then the Cloudflare Access revoke for the learner's `users.email` (run even when ending sessions failed), then the AC-12 audit row. The revoke makes up to 3 tries (the first at once, the second 2 seconds after the first fails, the third 5 seconds after the second fails) with a 5 second timeout on each. A 429, a 5xx, a timeout, or a network error is retried; any other reply is final for that learner. The breaker trips on a 401 or 403 (bad configuration) or when all 3 tries end `unavailable`; after it trips, every later revoke in the same reconciler run is recorded as `failed` without a call, while session ends and audit rows still happen. Any other 4xx is `failed` for that learner only. A pk with no `users` row (so no email) is `failed` with no call and does not trip the breaker. A failure logs a console error naming the user id (or the pk), never the email, the token, the request URL, or the response body. The 1 hour Access session stays the backstop.
- **AC-11**: `CLOUDFLARE_ACCOUNT_ID` and the token are both set or both unset. The token is read through the existing `secret()` helper in `server/env.ts` (`CLOUDFLARE_API_TOKEN_FILE`, else `CLOUDFLARE_API_TOKEN`). `workerEnv()` calls `cloudflareEnv()` and fails fast at start when only one is set, or when the token file is unreadable or empty. `worker/index.ts` builds the revoker before taking the lock. When both are unset, the worker logs "Cloudflare VM revoke is off" once at start and skips every revoke (outcome `off`). Only the worker reads them, never the web process, and the token never appears in a log, an error, or audit metadata.
- **AC-12**: The `access.revoked` audit row is written last, after the session end and the revoke (today it is written before the session end; this moves it). Its metadata gains `sessionsEnded` (`endAuthentikSessions(...).ok`) and `vmRevoke` (`'done' | 'failed' | 'off'`). A removal that fails still ends no sessions, makes no revoke call, and writes no audit row. There is no new `AuditAction` value.

## Decision

**Chosen option**: Option 1: links gated on a session that owns the booking, through one shared server read, and an inline Cloudflare revoke in the reconciler.

Every screen that shows lab links gets them from `ownLabAccess`, filtered by the session learner. The reconciler stays the only owner of access and gains a bounded, best effort Cloudflare Access revoke after each removal, gated on spike 3 passing first.

**Implementation skills**: `kysely` (`mindrally/skills`, `.claude/skills/kysely/`) · `zod` (`pproenca/dot-skills`, `.claude/skills/zod/`) · `shadcn` (`shadcn-ui/ui`, `.claude/skills/shadcn/`) · `shadcn-baseui` (`thunderboltdev/shadcn-baseui`, `.claude/skills/shadcn-baseui/`) · `vitest` (`antfu/skills`, `.claude/skills/vitest/`) · `playwright-best-practices` (`currents-dev/playwright-best-practices-skill`, `.claude/skills/playwright-best-practices/`)

## Rationale

Reasoning and options: see [rationale.md](rationale.md).

## Feature design

### Data model sketch

No migration. Everything used here already exists:

| Table | Used for | Access |
|---|---|---|
| `bookings` | ownership (`user_id`), `status`, `starts_at`, `ends_at`, `testbed_id`, `testbed_type_id` | read |
| `testbeds` | `name`, `portal_url`, `lms_url` (https only, `HttpsUrl` in `lib/catalog-input.ts`) | read |
| `testbed_clients` | `name`, `kind`, `url`, `position` (never `os_username`, `os_password`) | read |
| `testbed_types` | `name` | read |
| `users` | `role`, `status`, `email_verified_at`, `timezone`; `email` for the revoke | read |
| `audit_events` | `access.revoked` metadata gains `sessionsEnded`, `vmRevoke` | insert (existing write, moved) |

No new `AuditAction`, `JobKind`, or CHECK list.

### State transitions

No new states. The phase comes from `bookingPhase` (`lib/booking-phase.ts`) at `dbNow()`: Upcoming → Current → Past. Group membership is unchanged (spec 0004): not a member → member when Current → not a member at end or cancel. Removal now also triggers the revoke: removed → sessions ended → VM revoke (`done` | `failed` | `off`) → audit row.

### API surface

| Surface | Kind | Inputs | Outputs | Auth | Key errors |
|---|---|---|---|---|---|
| `ownLabAccess(conn, userId, bookingId)` in `server/booking/lab-access.ts` | server read | session user id, booking id | `{ kind: 'ok', access: LabAccessDetail } \| { kind: 'missing' }` | caller passes the session learner id | `missing` for every miss (AC-1) |
| `bookAction` (`app/book/actions.ts`) | Server Action, public | unchanged | `booked` reply gains `access: LabLinks \| null` | public allow list (unchanged); links only for a session owner | none new |
| `rescheduleAction` (`app/reservations/[id]/reschedule/actions.ts`) | Server Action | unchanged | `rescheduled` reply gains `access: LabLinks \| null` | `requireLearner()` (unchanged) | none new |
| `/reservations/[id]` (`app/reservations/[id]/page.tsx`) | page | `params.id` | the AC-7 page | `requireLearner()` | `notFound()` on `missing` |
| `revokeAccessUser(env, email)` in `server/cloudflare/access.ts` | outbound HTTP, one call | account id, token, email | `Result<void, 'unavailable' \| 'config' \| 'rejected'>` | Cloudflare API token (Bearer) | `unavailable` (429, 5xx, timeout, network; retryable), `config` (401, 403), `rejected` (any other non success) |
| `makeRevoker(env, { sleep })` in `server/cloudflare/access.ts` | factory, called once per `reconcileAccess` run | env, an injected `sleep` (real `setTimeout` from `node:timers/promises` in the worker) | `VmRevoker = (email: string \| null) => Promise<'done' \| 'failed'>`, owning the AC-10 retries and breaker in its own closure | none | never throws |
| `reconcileAccess(api, conn, newRevoker)` (`server/worker/reconcile.ts`) | worker step | `newRevoker: (() => VmRevoker) \| null` (null = off), called once at the start of each run | void | provisioning token, Cloudflare token | per group try and log (unchanged) |

Shared types in `lib/lab-access.ts` (safe on both sides): `LabLinks = { portalUrl, lmsUrl, clients: readonly { name, kind: ClientKind, url }[] }`, `LabAccessDetail = { testbedName, typeName, status: 'confirmed' | 'completed', startsAt: Date, endsAt: Date, links: LabLinks }`, plus the pure `labAccessView(phase)` → `{ note, active }` used by the card. For a Past booking the page maps `links` to `{ label, kind }` rows only before rendering (AC-8).

Cloudflare call, as of current knowledge (spike 3 confirms the exact path, body, reply, and token permission before task 5): `POST https://api.cloudflare.com/client/v4/accounts/{account_id}/access/organizations/revoke_user` with JSON `{ "email": "<email>" }` and `Authorization: Bearer <token>`. The reply is parsed with Zod (`{ success: boolean }`), and `success: true` on a 2xx means `done`. The call uses `fetch` with `AbortSignal.timeout(5000)` and adds no dependency.

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
| reconciler | `vmRevoke` | `'off'` when `revoker` is null; else `done` or `failed` from the AC-10 retry |
| `revokeAccessUser` | account id, token | `cloudflareEnv()` in `server/env.ts`: `CLOUDFLARE_ACCOUNT_ID`, token file read at start |

### Key invariants

- Lab links leave the server only for a session learner who owns the booking and is verified (AC-1). No public reply ever carries them (AC-3).
- `ownLabAccess` is the only read that returns lab links to a learner. It never selects client OS credentials (spec 0007; `tests/os-password-scan.test.ts` still allows `os_password` only in `server/catalog/testbeds.ts`).
- The reconciler stays the only code that adds or removes `pod-*` members, and the only caller of the Cloudflare revoke.
- The revoke runs only after a successful removal. The retry state (the breaker) is local to one `reconcileAccess` run (built per call), never a module variable.
- Worst case per run in a Cloudflare outage: one revoke's 3 tries (about 22 seconds) and then no more calls, so the step stays well inside `STEP_TIMEOUT_MS` (60 seconds).
- Past links are never rendered as anchors, and Past URLs never leave the server (AC-8).
- Accepted, not fixed: if a reconciler step overruns its timeout, the next run can overlap it and remove, revoke, and audit the same learner twice (harmless, since revoke and session end are idempotent). A learner removed from one group while Current on another in the same run can't happen, because of the one active booking rule and the one hour lead time on any new start. A signed in session whose `email_verified_at` is somehow null makes `ownLabAccess` return `missing`, so the card is simply left out; do not "fix" this by trusting the session alone.
- `/reservations/[id]` is dynamic because `requireLearner()` reads cookies. Never add `generateStaticParams` or a cache directive to it. The existing `/reservations/[id]/reschedule` page under the same segment keeps its own behavior.

### Security model

- Detail page: `requireLearner()`, then `ownLabAccess` filtered by the session user. Another learner's id behaves exactly like an unknown id (`notFound()`), so ids can't be probed.
- `bookAction` stays public. Identity for links comes only from the session (`sessionAccount`), never from the posted email (the AGENTS.md rule for signed in learners on `/book`).
- Links open with `rel="noopener noreferrer"`, so the lab site gets no `window.opener` and no Referer carrying the booking id. Stored URLs are https only (spec 0007).
- Client OS usernames and passwords never reach these screens (engineer call 2026-10-10, spec 0007 Follow-up). They go only in the booking email (feature 15).
- Cloudflare token: a file on the worker host (the `_FILE` pattern used for the Authentik token), read once by `cloudflareEnv()`. It never reaches the web process, a log, an error, or audit metadata. Least privilege: the token is scoped to the one account, with only the Access revoke permission spike 3 confirms.
- `revoke_user` acts on the whole Cloudflare account, so it also revokes any other Access app session that learner email holds there. Learners use only HOL labs, so this is accepted.

### Configuration required

- `CLOUDFLARE_ACCOUNT_ID`: the Cloudflare account that holds the VM Access apps (worker only; optional, paired with the next).
- `CLOUDFLARE_API_TOKEN_FILE`: path to a file holding a Cloudflare API token with only the Access revoke permission (worker only; optional, paired with the above). `CLOUDFLARE_API_TOKEN` works as the plain fallback through `secret()`, as for the other secrets.
- Add both, commented out, to `.env.example`. Dev leaves them unset (the worker runs only in production).

### Critical test scenarios

- `ownLabAccess` (DB, `inRollback`): own verified learner's Current booking returns links with clients in `position` order and no `os_` keys on any object; another learner's id, a cancelled booking, a provisioning booking, a learner with `email_verified_at` null, a deactivated learner, and a malformed id each return `missing`; a Past booking on a soft deleted testbed still returns its name and links. Verifies **AC-1**.
- `labAccessView` and `cardActions` (pure): Current and Upcoming are active with their notes, Past is inactive with the ended note; `viewAccess` is true for Current and Past only, and the Current order is Reschedule, View lab access, Cancel. Verifies **AC-6**, **AC-7**, **AC-8**.
- Success copy (component): `access` present renders the card with each "Open" link carrying `target` and `rel`; `newUser: true` renders the box and the AC-4 line with no card; `newUser: false` with `access: null` renders the AC-3 line and no card. Verifies **AC-2**, **AC-3**, **AC-4**.
- `bookAction` reply builder: no session yields `access: null` and the serialized reply contains none of the testbed's URLs, even when the email belongs to a verified learner; a matching session yields the links. Verifies **AC-2**, **AC-3**.
- Reschedule reply: a move to another testbed returns that testbed's links; a `missing` read still yields `rescheduled` with `access: null`. Verifies **AC-5**.
- Detail page auth: no session redirects through `requireLearner()`; another learner's booking id and a cancelled id render not found. Verifies **AC-7**.
- Past card (component, `renderToStaticMarkup` as in `booking-success.test.ts`): no `<a` and no `tabindex` inside the lab access card; none of the testbed's URLs appear anywhere in the markup; "Ended" tags and the ended note render; the tag's token pair is registered in `tests/design-contrast.test.ts`. Verifies **AC-8**.
- Reconciler (fake Authentik plus a fake revoker factory): a removal ends sessions, then calls the revoker once with `users.email`, then writes `access.revoked` with `sessionsEnded: true, vmRevoke: 'done'`; a failed session end still revokes and records `sessionsEnded: false`; a pk with no `users` row records `failed` with no revoker call; a null factory records `off`; a failed group removal ends no sessions, makes no revoke call, and writes no audit row. Verifies **AC-10**, **AC-12**.
- `makeRevoker` (an injected `sleep` that records its delays and resolves at once, and a local HTTP stub server, no mocks): `unavailable` 3 times gives `failed` after delays of 2000 and 5000 ms, and the next call in the same revoker makes no request and gives `failed`; a 403 gives `failed` with no retry and trips the breaker; a 400 gives `failed` for that learner only, and the next call still goes out; `null` email gives `failed` with no request. Verifies **AC-10**.
- `revokeAccessUser` (local HTTP stub server): 2xx with `success: true` is ok; 429, 503, and a timeout are `unavailable`; 401 and 403 are `config`; 400 is `rejected`; no error string or captured log line contains the token, the email, or the request URL. Verifies **AC-10**, **AC-11**.
- Env: both unset parses as off; only one set fails; an empty token file fails. Verifies **AC-11**.
- Playwright (the `learner` test account): sign in, book through signed in `/book`, and see "Your lab access" with the links under "View my reservations"; open `/reservations/<id>` directly and see the Upcoming note; the Upcoming card has no View lab access; cancel to clean up. An `afterEach` cancels any live booking the test account still holds, so a failed run never leaves it blocked by the one active booking rule on the shared database. Axe, keyboard, and screenshots on the success card and the detail page. Verifies **AC-2**, **AC-6**, **AC-7**.
- `verify.md` (manual, real Authentik and Cloudflare in `/check verify`): a `dev-` booking becomes Current, and the learner is in `pod-<slug>` within a tick and the links open; cancel it, and within a tick the membership is gone, the open VM tab is cut off, and the audit row shows `vmRevoke: 'done'`; its detail page then shows the Past state. Verifies **AC-8**, **AC-9**, **AC-10**, **AC-12**.

## Build plan

Tracer Bullet: spike 3 first (the one unknown, run alongside the rest), then a thin thread from the shared read to a real page, then thicken it: success screens, then the Cloudflare strand, then the end to end guards.

1. Spike 3 (throwaway, with the owner, on one VM's Access app): confirm the revoke endpoint path, body, reply, and the narrowest token permission; that revoke by email ends an already open browser rendered session within a minute; that a fresh sign in afterwards works and carries the current `groups` claim; that the Access policy matches `pod-<x>` in that claim; and whether browser rendered RDP is GA. Record the results in `rationale.md` under *Spike 3 evidence*. A failure returns to `/architect` before task 5. Satisfies **AC-10**
2. Tracer: `lib/lab-access.ts` (`LabLinks`, `labAccessView`), `server/booking/lab-access.ts` `ownLabAccess`, the shared `components/reservations/lab-access-card.tsx` (success and detail variants, active and ended rows), the `/reservations/[id]` page, and `viewAccess` in `cardActions` with the View lab access link on Current and Past cards. Satisfies **AC-1**, **AC-6**, **AC-7**, **AC-8**
3. Success screens: the `access` field on the `booked` and `rescheduled` replies, the card and the AC-3 and AC-4 copy in `booking-success.tsx`, and the card in `reschedule-success.tsx`. Satisfies **AC-2**, **AC-3**, **AC-4**, **AC-5**
4. Cloudflare module and env: `cloudflareEnv()` in `server/env.ts` (both or neither, the token through `secret()`, called from `workerEnv()`), `server/cloudflare/access.ts` with `revokeAccessUser` (fetch, timeout, Zod reply, `Result`) and `makeRevoker` (retries, breaker, injected `sleep`), and `.env.example`. Satisfies **AC-10**, **AC-11**
5. Reconciler strand: the new removal order (sessions, revoke, audit), the email lookup, `sessionsEnded` and `vmRevoke` in the audit metadata, and the worker wiring (the revoker factory from `cloudflareEnv()` built before the lock, the one time "off" log). Satisfies **AC-9**, **AC-10**, **AC-11**, **AC-12**
6. Guards and end to end: auth tests for the detail page, the Playwright journey with axe, keyboard, and screenshots, and `verify.md` with the manual real access steps. Satisfies **AC-2**, **AC-3**, **AC-7**, **AC-8**, **AC-9**, **AC-10**, **AC-12**

## Consequences

**Positive**:
- One read (`ownLabAccess`) decides who sees links on every screen, so the ownership rule lives in one tested place.
- Open VM sessions get a hard cut within about a tick of the booking ending, cancel, or deactivation, instead of up to an hour later.
- No migration, no new enum value, and no new dependency. Cloudflare stays optional, so the worker runs before the owner finishes the Access setup.

**Negative / tradeoffs**:
- A guest who is not signed in never sees links on the success screen. Until feature 15 sends the booking email, they find the links in the app only once the lab is Current (the Upcoming detail page is reachable by URL only).
- A failed revoke is not retried after its run, because the membership is already gone. That VM session then lasts up to the 1 hour Access backstop, visible only in the log and the audit metadata.
- During a Cloudflare outage one run spends up to about 22 seconds on retries, delaying the teardown step behind it.
- Revoke is account wide for that email (see Security model).
- Links can be refused for up to about 30 seconds after the start, until the reconciler's next tick. The note says so.
- Nile Portal and Moodle sessions already open still outlive the booking until their own timeouts (unchanged from spec 0001).

**Neutral**:
- `reconcileAccess` takes a third argument, and the worker builds it.
- The audit row for a removal moves later in the removal, so a crash between removal and audit loses that row (the same risk as today, slightly longer).

## Follow-up

- [ ] `/scope`: reword feature 14's done line as spec 0001 Follow-up (a) asked ("open VM sessions are cut off at once; Nile Portal and Moodle block new sign ins at once and open sessions end at their own short timeout"), and note that scope line 17's "how the success screen reads before verification" is settled here (AC-3, AC-4).
- [ ] Owner: create a Cloudflare API token scoped to the HOL account with only the Access revoke permission (named in spike 3), save it as a file on the worker host, and set `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN_FILE` for the worker.
- [ ] Spec 0001 image and compose work: mount the Cloudflare token as a secret file on the `worker` container only (never `web`), alongside the Authentik provisioning token.
- [ ] Feature 15: the booking email carries the lab links (and the client OS logins) for every learner, which covers the anonymous guests AC-3 leaves without links; it also adds Add to calendar and View email on the success screens.
- [ ] On build, close spec 0004 Follow-up "Feature 14 / spike 3", spec 0010 Follow-up "Feature 14: add the lab access card", and spec 0011 Follow-up "Feature 14: add View lab access".
- [ ] `/sync`: `server/worker/AGENTS.md` should say the reconciler also calls the Cloudflare revoke, with the retry and breaker rule; root `AGENTS.md` should name `ownLabAccess` as the only lab link read.
