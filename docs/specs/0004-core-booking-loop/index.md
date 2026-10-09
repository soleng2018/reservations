# 0004. Core booking loop

**Date**: 2026-10-08
**Status**: In Progress

## Summary

This is the walking skeleton: the first thread that runs through every layer for real. An admin signs in and creates one testbed type and one testbed (which creates its Authentik pod group). A guest fills the Step 1 form on `/book`, picks a free start time from a plain list, and confirms. The existing guest saga then creates their Authentik user and the booking together. A new background worker, started by hand with `npm run worker`, adds the learner to the testbed's pod group when the booking starts and removes them when it ends. Nothing is styled beyond stock shadcn, and there is no calendar, email, cancel, or edit yet.

## Requirements

**User stories**:
- As an admin, I want to create a testbed type and a testbed from the console, so that guests have something real to book.
- As a guest, I want to enter my details, pick a free start time, and confirm, so that I get a testbed for my lab window and an account to manage it.
- As the owner, I want a failed booking to leave nothing behind and lab access to exist only during the booking, so that Authentik and the database never drift into a half done state.

**Acceptance criteria**:
- **AC-1**: On `/admin`, an admin can create a testbed type (name, duration value of at least 1, unit `hours` or `days`). Invalid input shows a field error, and a duplicate name (ignoring case) shows "A testbed type with this name already exists." The page lists the existing types and testbeds (name, type, and whether the pod group exists), with no edit or delete.
- **AC-2**: On `/admin`, an admin can create a testbed (name, type, Nile Portal URL, LMS URL, and zero or more clients, each with a kind, name, and URL). Saving inserts the row with a slug and no group, creates the Authentik group `pod-<slug>` with the provisioning token, then stores its pk. The group carries the attribute `hol_testbed_id = <testbeds.id>`. If the group step fails or times out, or a group named `pod-<slug>` already exists (it is never adopted), the admin sees "Couldn't create the testbed's access group, try again", and no testbed row and no group this attempt created remain. A testbed becomes bookable only once its group pk is stored. Inputs: name trimmed, 1 to 200 characters; URLs must be `https:`; client `kind` is `TestbedClientKind` (`wired` | `wireless`), client name 1 to 200 characters.
- **AC-3**: `/book` shows the Step 1 form: name, company, email, lab type, and timezone. Lab type lists only the types that have at least one bookable testbed. Timezone defaults to the browser's zone and offers every zone from `Intl.supportedValuesOf('timeZone')`, plus `UTC`, plus the browser's own zone if the list lacks it (an alias such as `Asia/Calcutta`). Name and company are required, trimmed, 1 to 200 characters; email is trimmed, at most 254 characters, a valid address. Once a type is chosen, the page lists the free start times, grouped by day and shown in the chosen timezone. A start is listed when it is on a :00 or :30 boundary (UTC), at least 1 hour from now, within 14 days from now, and at least one bookable testbed of that type has no live booking overlapping `[start, start + duration)`. Changing the type reloads the list; changing the timezone reformats it. The list shows the first 7 days, with a "Show more days" control for the rest. A type with no free starts shows "No free times in the next 14 days." Loading starts is limited to 60 calls per IP per 10 minutes (over the limit returns an empty list and "Please try again in a little while.").
- **AC-4**: Confirm runs its checks in this order, before any booking write: (1) count the IP bucket (5 per 10 minute window); (2) verify Turnstile (failing closed when Cloudflare is unreachable); (3) parse the form with Zod (lengths, email shape, a timezone accepted by `new Intl.DateTimeFormat(undefined, { timeZone })`); (4) count the email bucket (3 per lowercased email per hour). Every attempt that reaches a bucket counts. A failed limit or Turnstile check shows "Please try again in a little while."; a failed parse shows field errors. Nothing else is written. The client resets the Turnstile widget after every failed submit (tokens are single use).
- **AC-5**: The server assigns the testbed inside saga step 1, while the user row is locked `FOR UPDATE`. It first checks the user has no live booking (`provisioning` or `confirmed`) with a plain select. It then reads the type under `FOR SHARE`, computes `ends_at = starts_at + durationMs(type)` from that read only, and rechecks the start against the AC-3 rules with DB `now()`. Then, for each bookable testbed of the type in `lower(name)` order, it takes `lockBookableTestbed` (skipping a testbed that is `not_bookable`) and inserts the booking with `ON CONFLICT DO NOTHING RETURNING id`. An empty result (overlap) moves on to the next testbed, and the first returned id wins.
- **AC-6**: On success, the page replaces the form with a confirmation that shows the lab type, the testbed name, and the start and end in the learner's timezone. A newly created user also sees "Check your email for a link to set your password." A reused user sees "Sign in to manage your reservation" with a link to `/reservations`. No lab links are shown.
- **AC-7**: If every testbed of the type is taken for that start by the time of submit, or the start no longer passes the AC-3 rules (it crossed the lead time, for example), the guest sees "That time was just taken. Please pick another." The form keeps what they typed, and the start list reloads without that time.
- **AC-8**: If the email already has an Upcoming or Current booking, the guest sees "You already have an active booking. Sign in to manage it." with a link to `/reservations`. If its live booking is still `provisioning` (a double submit, or another attempt in flight), the guest sees "Your booking is still being set up. Please try again in a minute." An admin email or a deactivated user gets the messages from spec 0003 AC-5.
- **AC-9**: If Authentik is unreachable, times out, or refuses the user in saga step 2, the guest sees the matching message from spec 0003 (AC-5, AC-15). Afterwards there is no booking, no Authentik user this attempt created, no orphan `users` row, and no pod group membership. The booking path never writes group membership. A refusal inside step 1 (`slot_taken`, `has_live_booking`, `booking_pending`, `not_bookable`, `admin_email`, `refused`) rolls back the whole step 1 transaction, so a new email leaves no `users` row (today `startGuestBooking` commits the row when it returns an error; this slice fixes that).
- **AC-10**: Two guests who submit the same type and overlapping start at the same moment never get the same testbed. With one free testbed, exactly one booking is confirmed and the other guest sees the AC-7 message. With two free testbeds, both succeed on different testbeds.
- **AC-11**: `npm run worker` starts the worker only when `WORKER_ENABLED=true`; otherwise it logs the reason and exits 0. It takes a Postgres advisory lock (`pg_try_advisory_lock`) on one dedicated `pg` client held for the life of the process (not a pooled connection), so a second copy logs "another worker holds the lock" and exits. If that client's connection drops, the worker exits non zero. It runs a sequential loop (await the tick, then sleep 30 seconds, so ticks never overlap). Each tick runs, in order, each step with a 60 second timeout: complete ended bookings; the guest saga sweeper (compensate `provisioning` bookings older than 10 minutes); the testbed create sweeper; the access reconciler; and once a day, purging `rate_limits` rows older than 2 hours. The testbed create sweeper takes a testbed with no group pk and `created_at` older than 10 minutes, locks it `FOR UPDATE`, deletes `pod-<slug>` only if that group exists and its `hol_testbed_id` equals the row id, then runs `DELETE ... WHERE id = $1 AND authentik_group_pk IS NULL`. One failing step is logged and does not stop the others or the next tick. On SIGTERM it finishes the current step and exits.
- **AC-12**: For every testbed with a group pk (soft deleted ones included, with an empty desired set), the reconciler makes the `pod-<slug>` members match the learners whose booking on it is `confirmed` with `starts_at <= now() < ends_at` (DB clock). It reads members page by page (100 per page) with their attributes. It adds missing learners (skipping any whose `authentik_user_pk` is null). It removes extra members only when they carry `hol_learner = true`, and then deletes that learner's Authentik sessions (this also ends their Authentik login, so they sign in again to manage bookings; accepted). It never touches untagged members. A group that returns 404 is logged and skipped. A failure on one group is logged and the other groups still run. Each add and remove is audited only after the Authentik write succeeds.
- **AC-13**: The admin create actions call `requireAdmin()`. A learner or anonymous caller gets the existing "not authorized" result and nothing is written. The public `/book` actions (`loadStartsAction`, `bookAction`) are on the allow list in `tests/server-actions-require.test.ts`. No page in the booking flow links to the admin URL.

## Decision

**Chosen option**: Option 1: a thin end to end slice on the existing saga, with a minimal worker that owns lab access.

The guest flow reuses `bookAsGuest` with server side testbed assignment, and the admin gets create only forms that run a row first group saga. A hand started worker (reconciler plus sweepers) is the only code that adds or removes pod group members, as spec 0001 requires.

**Implementation skills**: `kysely` (`mindrally/skills`, `.claude/skills/kysely/`) · `zod` (`pproenca/dot-skills`, `.claude/skills/zod/`) · `shadcn` (`shadcn-ui/ui`, `.claude/skills/shadcn/`) · `vercel-react-best-practices` (`vercel-labs/agent-skills`, `.claude/skills/vercel-react-best-practices/`) · `vitest` (`antfu/skills`, `.claude/skills/vitest/`) · `playwright-best-practices` (`currents-dev/playwright-best-practices-skill`, `.claude/skills/playwright-best-practices/`)

## Rationale

Reasoning and options: see [rationale.md](rationale.md).

## Feature design

### Data model sketch

No migration. This slice builds entirely on spec 0002's tables, as they already exist:

| Table | Used for | Columns this slice writes |
|---|---|---|
| `testbed_types` | AC-1 | `name`, `duration_value`, `duration_unit` |
| `testbeds` | AC-2, bookability | `name`, `slug` (via `slugify` plus the `-2`, `-3` collision suffix), `testbed_type_id`, `portal_url`, `lms_url`, `authentik_group_pk` |
| `testbed_clients` | AC-2 | `kind`, `name`, `url`, `position` (form order from 0) |
| `users`, `bookings` | AC-5 to AC-10 | through the existing saga (`server/db/guest-saga.ts`) |
| `rate_limits` | AC-4 | buckets `book:ip:<ip>` (10 minute window) and `book:email:<lower email>` (1 hour) |
| `audit_events` | AC-1, 2, 12 | new actions below |

New audit actions (added to `lib/audit-actions.ts`): `testbed_type.created`, `testbed.created`, `authentik_group.created`, `authentik_group.deleted` (the create sweeper or an in line undo), `booking.created`, `access.granted`, `access.revoked`. Target types already exist (`testbed_type`, `testbed`, `authentik_group`, `booking`, `user`).

### State transitions

**booking.status**: unchanged from spec 0002. This slice uses insert → `provisioning` → `confirmed` (saga), `provisioning` → deleted (compensation, sweeper), and `confirmed` → `completed` (worker).

**Testbed create (the bookable flag, derived)**:
- (insert, group pk null): not bookable.
- → group pk set: bookable.
- → hard deleted: the in line undo when the group step fails, or the create sweeper after 10 minutes by `created_at`. Only a row that never had a group pk is ever hard deleted.

**Pod group membership (Authentik, owned by the reconciler only)**: not a member → member when a confirmed booking's window starts → not a member when it ends (or the booking stops being `confirmed`). Removal also deletes the learner's Authentik sessions.

### API surface

| Surface | Kind | Key inputs | Key outputs | Auth | Key errors |
|---|---|---|---|---|---|
| `/admin` page | Server Component | none | create forms, type and testbed lists | `requireAdmin()` | not authorized |
| `createTestbedTypeAction` (`app/admin/actions.ts`) | Server Action | `name`: string (req), `durationValue`: int ≥ 1 (req), `durationUnit`: `hours`\|`days` (req) | `Result<{ id }, …>` mapped to form state | `requireAdmin()` | `invalid`, `duplicate_name` |
| `createTestbedAction` (`app/admin/actions.ts`) | Server Action | `name` (req), `testbedTypeId`: uuid (req), `portalUrl`: url (req), `lmsUrl`: url (req), `clients`: `{ kind, name, url }[]` (opt) | `Result<{ id, slug }, …>` | `requireAdmin()` | `invalid`, `duplicate_name`, `type_not_found`, `group_failed` |
| `/book` page | Server Component plus a client form | none | bookable types, Turnstile site key | public, `noindex` | none |
| `loadStartsAction` (`app/book/actions.ts`) | Server Action | `testbedTypeId`: uuid (req) | `{ starts: readonly string[] }` of ISO UTC starts, or `{ limited: true }` | public (allow list), 60 per IP per 10 min | `type_not_found` gives an empty list |
| `bookAction` (`app/book/actions.ts`) | Server Action (`useActionState`) | `name`, `company`, `email`, `timezone`, `testbedTypeId`, `startsAt`: ISO string, `cf-turnstile-response` | state `{ kind: 'booked', typeName, testbedName, startsAt, endsAt, timezone, newUser } \| { kind: 'error', code, fields }` | public (allow list) | `invalid`, `limited`, `slot_taken`, `has_live_booking`, `booking_pending`, `admin_email`, `refused`, `unavailable`, `gone` |

Server modules:

| Module / function | Signature | Notes |
|---|---|---|
| `lib/slots.ts` `freeStarts` | `(args: { now: Date; leadMs: number; horizonMs: number; durationMs: number; testbedIds: readonly string[]; busy: readonly { testbedId; startsAt; endsAt }[] }) => readonly Date[]` | Pure. A start is free when any testbed id has no busy range overlapping `[s, s + duration)`. |
| `lib/slots.ts` `isOfferableStart` | `(start: Date, now: Date, leadMs, horizonMs) => boolean` | Pure, the server recheck for AC-4. |
| `lib/timezones.ts` `Timezone`, `timezoneOptions` | Zod string refined by a `new Intl.DateTimeFormat(undefined, { timeZone })` try/catch; `(browserZone: string) => readonly string[]` (the supported list plus `UTC` plus the browser zone, sorted, no duplicates) | The list is for display; the refine is the check, so ICU differences between browser and Node never reject a real zone. |
| `server/booking/availability.ts` `bookableTypes`, `startsFor` | `(conn) => …`, `(conn, typeId) => readonly Date[]` (reads DB `now()` itself) | Reads live bookings overlapping the window. |
| `server/db/guest-saga.ts` `startGuestBooking` | input drops `testbedId` and `endsAt`, keeps `testbedTypeId` and `startsAt`; returns `Result<SagaRef & { testbedName, typeName, endsAt }, 'admin_email' \| 'refused' \| 'has_live_booking' \| 'booking_pending' \| 'not_bookable' \| 'slot_taken'>` | Runs the AC-5 steps. Any error rolls back the transaction: the caller wraps it as `trx.execute` that throws a typed `StepOneRefusal` sentinel carrying the error, catches it outside, and returns `err(code)`. `not_bookable` means the type has no bookable testbed at all. |
| `server/booking/guest-booking.ts` `bookAsGuest` | input as above | Unchanged steps 2 and 3. |
| `server/rate-limit.ts` `countAttempt` | `(conn, bucketKey, limit, windowSeconds: number) => Promise<boolean>` | Buckets by `to_timestamp(floor(extract(epoch from now()) / w) * w)`. `countHourlyAttempt` becomes `countAttempt(conn, key, limit, 3600)`. Buckets: `book:ip:<ip>` (5, 600 s), `book:email:<lower email>` (3, 3600 s), `starts:ip:<ip>` (60, 600 s). The email key is built only after the Zod parse. |
| `server/request-ip.ts` `clientIp` | `(headers: Headers) => string` | With `TRUST_PROXY_HEADERS=true`, the `CF-Connecting-IP` header; otherwise the literal `untrusted` (one shared bucket, best effort). |
| `server/catalog/testbeds.ts` `createTestbed` | `(api, conn, input, actor) => Promise<Result<{ id, slug }, …>>` | The row first group saga (AC-2). |
| `server/authentik/groups.ts` `createPodGroup`, `deletePodGroup`, `findPodGroupByName`, `podGroupMembers` | through `guardGroupWrite` / `checkGroupWrite` | Group attribute `{ hol_testbed_id }`. |
| `lib/reconcile.ts` `membershipDiff` | `(desired: ReadonlySet<number>, actual: readonly { pk; holLearner: boolean }[]) => { add: readonly number[]; remove: readonly number[] }` | Pure. `remove` holds only `holLearner` members. |
| `server/worker/reconcile.ts` `reconcileAccess` | `(api, conn) => Promise<void>` | Per group try and log, then audit and end sessions per removal. Each change costs about 3 Authentik calls (the guard rereads group and user), fine at this scale. |
| `server/worker/sweep.ts` `sweepGuestSagas`, `sweepTestbedCreates`, `completeEnded`, `purgeRateLimits` | `(api, conn) => Promise<void>` | Reuse `staleProvisioning` and `compensateGuestBooking`. |
| `worker/index.ts` | the sequential loop | Own `pg.Client` for the advisory lock (key: a constant in code). `npm run worker` = `tsx --conditions=react-server --env-file-if-exists=.env.local worker/index.ts`. Confirm in build task 7 that `DATABASE_*` points at Postgres directly, not a transaction mode pooler (else the session lock would not hold). |

### Value sourcing

| Action | Value | Source |
|---|---|---|
| `loadStartsAction` | `now` | DB `now()` read once per call (spec 0001: the DB is the clock) |
| `loadStartsAction` | lead time, horizon | constants in `lib/slots.ts`: `LEAD_MS` = 1 hour, `HORIZON_MS` = 14 days (feature 12 may move them to config) |
| `loadStartsAction` | duration | `testbed_types.duration_value` and `duration_unit` through `durationMs` |
| `loadStartsAction` | busy ranges | live `bookings` of the type's bookable testbeds overlapping `[now, now + horizon + duration)` |
| `/book` | listed day groups and times | client `Intl.DateTimeFormat` with the selected `timezone` field |
| `/book` | default timezone | browser `Intl.DateTimeFormat().resolvedOptions().timeZone`, falling back to `UTC` when it fails the `Timezone` check |
| `bookAction` | `startsAt` | form value (the ISO string from the list), checked by `isOfferableStart` against DB `now()` inside step 1 |
| `bookAction` | `endsAt` | `startsAt + durationMs(type)` from the one type read under `FOR SHARE` in step 1 |
| `bookAction` | `testbedId` | the first `ON CONFLICT DO NOTHING` insert that returns an id (AC-5), never from the client |
| `bookAction`, `loadStartsAction` | client IP for rate limits | `clientIp(headers)`: `CF-Connecting-IP` only when `TRUST_PROXY_HEADERS=true`, else `untrusted` |
| `/book` (Playwright) | Turnstile token | Cloudflare's published always pass test site and secret keys, set in the test env only |
| tests and manual runs | test emails | addresses starting `dev-` (spec 0001), e.g. `dev-guest-<random>@nile-test.invalid` |
| `bookAction` success | `typeName`, `testbedName` | the type and testbed rows read in step 1 |
| `bookAction` success | `newUser` | saga step 2 `created` flag (`findOrCreateLearner`) |
| `bookAction` success | display timezone | the submitted `timezone` (also stored on a new `users` row; an existing user's stored zone is not changed) |
| `createTestbedAction` | `slug` | `slugify(name)`, with the suffix loop on `testbeds_slug_uq` |
| `createTestbedAction` | group name | `pod-<slug>` |
| `createTestbedAction` | `authentik_group_pk` | the pk Authentik returns from group create |
| admin lists | "group ready" flag | `testbeds.authentik_group_pk is not null` |
| reconciler | desired members | `users.authentik_user_pk` of `confirmed` bookings with `starts_at <= now() < ends_at` per testbed |
| reconciler | actual members and `hol_learner` | Authentik group read (`podGroupMembers`) including user attributes |
| audit entries | actor | `requireAdmin()` session user for admin actions; null for the worker and the guest flow |

### Key invariants

- Only the reconciler adds or removes `pod-*` members. The booking path and the admin forms never do (spec 0001).
- The client never picks the testbed or the end time; the server derives both.
- No booking is confirmed on a testbed without a group pk (`lockBookableTestbed`, spec 0002 AC-14).
- A testbed row is hard deleted only if it never had a group pk.
- The reconciler removes only `hol_learner` tagged users, and every Authentik write still passes `guard.ts`.
- Only one worker runs at a time (advisory lock on a dedicated connection).
- The IP bucket is counted before Turnstile, so a failed Turnstile still uses it up; the email bucket is counted only after the email parses.
- A step 1 refusal never commits anything.
- No app code deletes a `pod-*` group unless its `hol_testbed_id` matches a testbed row that never had a group pk.

### Security model

- Admin actions: `requireAdmin()`, and the group writes use the provisioning token through the `pod-*` guard (spec 0003 AC-4). The master token is never loaded by `web` or `worker`.
- Guest actions are public: Turnstile, plus IP and email rate limits, plus server side checks of every field. `loadStartsAction` returns only ISO times, never testbed names or other bookings.
- The confirmation is rendered from the action's return state, never from a URL parameter, so no booking can be read by guessing a link.
- PII (name, company, email, timezone) is stored as spec 0002 describes. Audit metadata holds ids and pks, never emails.
- `/book` is `noindex` until feature 11 decides on SEO.

### Configuration required

- `WORKER_ENABLED`: must be `true` for `npm run worker` to run (already named in spec 0001; add it to the worker env schema in `server/env.ts` and to `.env.example`, default false).
- `TRUST_PROXY_HEADERS`: `true` only where every request arrives through the Cloudflare Tunnel (production), so `CF-Connecting-IP` can be trusted. Default false (in `server/env.ts` and `.env.example`).
- Existing settings only otherwise: `DATABASE_*`, `AUTHENTIK_*` (provisioning token), `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`.
- Prerequisite: shadcn initialized (`components.json`, `components/ui/`) with `button`, `input`, `label`, `select`, `card`.

### Critical test scenarios

- Happy path (Playwright): an admin creates a type and a testbed (pod group appears in Authentik); a guest with a `dev-` email books the first listed start; the confirmation shows the type, testbed, and times in the chosen zone; the DB holds one confirmed booking and Authentik one tagged user. Verifies **AC-1**, **AC-2**, **AC-3**, **AC-5**, **AC-6**.
- Slots (unit): `freeStarts` at boundaries: lead time exactly 1 hour, horizon end, back to back bookings, a day long type, two testbeds with one busy. Verifies **AC-3**.
- Assignment race (DB integration, two connections, rolled back): two inserts for the same range with one free testbed, so one succeeds and one gets `slot_taken`; with two testbeds, both succeed on different ones. Verifies **AC-5**, **AC-7**, **AC-10**.
- Step 1 rollback: a new email that gets `slot_taken` (and separately `not_bookable`) leaves no `users` row. Verifies **AC-9**.
- Live booking: a second booking for the same email returns `has_live_booking`; one while the first is `provisioning` returns `booking_pending`. Verifies **AC-8**.
- Stale start: a start inside the lead time at submit returns `slot_taken`. Verifies **AC-7**.
- Authentik failure (fake Authentik timeout in step 2): no booking, no user row, no membership call made. Verifies **AC-9**.
- Abuse guard: a sixth attempt from one IP in 10 minutes and a fourth per email per hour are refused before the saga; a bad Turnstile token writes no booking. Verifies **AC-4**.
- Parse: name or company empty or over 200 characters, an email over 254, an `http:` URL, and an unknown timezone are refused with field errors. Verifies **AC-2**, **AC-4**.
- Testbed create failure (fake Authentik): group create fails, so no row remains; an existing `pod-<slug>` is refused, not adopted; the crash after group create but before the pk is stored is cleaned up by `sweepTestbedCreates` (group and row both gone); a group whose `hol_testbed_id` differs is left alone; a row whose pk was stored just before the sweep is not deleted. Verifies **AC-2**, **AC-11**.
- Reconciler (unit plus fake Authentik): `membershipDiff` adds the Current learner, removes an ended tagged learner, keeps an untagged member; a soft deleted testbed's group is emptied of tagged learners; a 404 group and a failing group do not stop the next; a failed add writes no audit row; each removal ends the sessions and writes `access.revoked`; members over 100 are read across pages. Verifies **AC-12**.
- Worker: without `WORKER_ENABLED` it exits 0; a second copy exits on the advisory lock; a step that throws does not stop later steps. Verifies **AC-11**.
- Starts limit: the 61st `loadStartsAction` from one IP in 10 minutes returns `limited`. Verifies **AC-3**.
- Auth: a learner session calling either admin action gets not authorized and writes nothing; the allow list test passes. Verifies **AC-13**.

DB tests run in `inRollback` (with `asConn(trx)` for the saga). A real Authentik membership check needs a booking whose window has started, so `/check verify` confirms it by watching the worker log and the group in Authentik when a `dev-` booking starts (at least 1 hour after booking, because of the lead time).

## Build plan

Tracer Bullet: prove the admin, then the guest, then the access thread end to end on the thinnest UI, then thicken each strand with its failure paths.

1. [x] Init shadcn (`button`, `input`, `label`, `select`, `card`). Add `createPodGroup`, `deletePodGroup`, `findPodGroupByName`, and `podGroupMembers` to `server/authentik/groups.ts` with guard tests on the fake. Satisfies **AC-2**, **AC-12**
2. [x] Admin tracer: `createTestbedTypeAction`, `createTestbedAction` with `server/catalog/testbeds.ts` (row first group saga with in line undo), the create forms and read only lists on `/admin`, and the new audit actions. Satisfies **AC-1**, **AC-2**, **AC-13**
3. [x] Slot math: `lib/slots.ts` (`freeStarts`, `isOfferableStart`), `lib/timezones.ts`, and `server/booking/availability.ts`, with unit tests and a rolled back integration test of `startsFor`. Satisfies **AC-3**
4. [x] Saga step 1 rework: `startGuestBooking` with the live booking check, the single type read, `ON CONFLICT DO NOTHING` assignment loop, and the rollback on every refusal (fixing today's committed orphan row), with rolled back tests. Satisfies **AC-5**, **AC-8**, **AC-9**
5. [x] Guest tracer: `/book` page and client form, `loadStartsAction`, `bookAction` on `bookAsGuest`, the confirmation state, the error code messages, allow list entries, and `noindex`. Satisfies **AC-3**, **AC-6**, **AC-7**, **AC-8**, **AC-9**, **AC-13**
6. [x] Abuse guard: `countAttempt`, `clientIp` with `TRUST_PROXY_HEADERS`, the check order, Turnstile on `/book` with widget reset, the starts limit, and the server rechecks. Satisfies **AC-3**, **AC-4**
7. [ ] Concurrency and failure tests: the two connection assignment race, the Authentik timeout, and the admin create failure. Satisfies **AC-2**, **AC-9**, **AC-10**
8. [x] Worker: `worker/index.ts` (env gate, dedicated lock client, sequential loop, step timeouts, SIGTERM), `completeEnded`, `sweepGuestSagas`, `sweepTestbedCreates`, `purgeRateLimits`, and the `npm run worker` script, plus the env schema and `.env.example`. Satisfies **AC-11**
9. [x] Access: `lib/reconcile.ts` `membershipDiff` and `server/worker/reconcile.ts` with paging, session cut off, and audit after success, unit and fake Authentik tests. Satisfies **AC-12**
10. [x] Playwright happy path (admin creates, guest books) against the dev server. Satisfies **AC-1**, **AC-2**, **AC-3**, **AC-5**, **AC-6**

## Consequences

**Positive**:
- Every layer is proven connected: admin auth, Authentik groups, the public form, the saga, the DB constraints, and the worker.
- Lab access already follows the booking window, so later slices (cancel, reschedule, deactivate) only change bookings and let the reconciler follow.
- Testbed assignment heals races by itself: an overlap just moves on to the next testbed.

**Negative / tradeoffs**:
- One host is both dev and prod, so the hand started worker **is** the production worker. Starting it in a dev shell reconciles real groups. The advisory lock prevents two, but someone has to keep it running until the image and compose service exist.
- Until feature 15, `send_welcome` jobs pile up as `pending` and new guests receive no set password email. A new guest can't sign in to manage the booking yet. The confirmation says to check their email, and that email arrives only once the job runner ships.
- Access starts up to 30 seconds after the booking's start time and ends up to 30 seconds after its end (the tick).
- Cloudflare Access revoke is not done yet, so an open browser rendered VM session runs on until its 1 hour Access session expires.
- A testbed whose create was undone frees its slug for reuse. This slightly loosens spec 0002's "never reused" rule, which is safe only because that testbed never had a group or a booking.
- The admin UI here is throwaway; slice 2 replaces it.
- Anyone who knows an email can use up its 3 per hour booking bucket (accepted; Turnstile and the IP bucket blunt it). In dev, with `TRUST_PROXY_HEADERS` off, every request shares one IP bucket.
- AC-8's message confirms to anyone that an email holds a booking (the engineer's choice, accepted behind Turnstile and the limits).
- If an in line testbed undo itself fails, an admin retry of the same name gets `duplicate_name` until the sweeper clears the row (up to about 10 minutes).
- Known gap from before this slice: a compensation that deletes the booking but then fails to delete the Authentik user leaves that user, and no sweeper finds it (the sweeper keys on bookings). It stays tagged with `hol_user_id` for a later cleanup.

**Neutral**:
- No migration. `countHourlyAttempt` becomes a thin call to `countAttempt`.
- Start times are on UTC :00 and :30, so learners in a zone with a :45 offset see starts at :15 and :45 local time.

## Follow-up

- [ ] Scope row 6: reword its description and done line from "adds the user to the testbed's Authentik group" to "the worker adds the learner to the testbed's group when the booking starts" (spec 0001's reconciler rule, engineer's call 2026-10-08).
- [ ] Spec 0002 follow-up "Feature 6 / 12: Turnstile and the rate limit table" is settled here: feature 6 adds them for booking.
- [ ] Spec 0002 follow-up for feature 9's sweeper of a testbed whose group was never created is built here (`sweepTestbedCreates`); feature 9 reuses it.
- [ ] Feature 15: the job runner in the worker, so the pending `send_welcome` jobs go out.
- [ ] Feature 14 / spike 3: Cloudflare Access revoke on reconciler removal.
- [ ] Spec 0001 image build: bundle `worker/index.ts` with esbuild and add the compose service, replacing `npm run worker` on the host.
- [ ] `/sync`: record `npm run worker` and the `WORKER_ENABLED` rule in `AGENTS.md` Commands.
