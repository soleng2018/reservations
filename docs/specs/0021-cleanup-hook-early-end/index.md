# 0021. Cleanup hook for labs that end early

**Date**: 2026-10-26
**Status**: Accepted

## Summary

Spec 0020 holds a testbed for 30 minutes after a lab ends, but a lab that ends early (a Current booking cancelled, or moved to another time) frees the testbed at once, and the cleanup automation only runs at the booked end time. This spec adds a signed call from the worker to an owner configured URL whenever a Current booking ends early, so the automation can reset the testbed right then. The URL and signing secret are saved as a new API key type in the admin console. With no key saved, nothing changes.

## Context

The cleanup automation lives outside this repo and today acts only when a booking reaches its `ends_at`. Spec 0020 accepted that an early cancel or a moved Current booking frees the testbed immediately, so the next learner may start soon after a lab that was in use and the automation never learns the lab stopped early. The app already has a database job queue, a worker that sends work after the booking transaction commits, and an encrypted API keys page. The Cloudflare revoke is the closest precedent: one live key, off when absent, worker only.

## Requirements

**User stories**:
- As a lab owner, I want my cleanup automation told the moment a Current lab ends early so that it can reset the testbed without waiting for the booked end time.
- As an admin, I want to set the hook URL and signing secret in the console, with the secret write only, so that rotating it needs no redeploy and nothing leaks.
- As a learner, I want cancelling or moving a lab to behave exactly as before, so that a slow or broken hook never blocks me.

**Acceptance criteria** (the contract, each independently checkable):
- **AC-1**: The API Keys form offers a type `CLEANUP`. Its Base URL is the hook URL and must parse as `https`, with no username or password in it and no fragment. Its secret (the signing secret) is required on add and is at least 16 characters. The existing URL rules (no query string) apply too. A blank secret on edit keeps the stored one, so the 16 character minimum applies only to a non blank secret; the secret is trimmed, and the signature uses the trimmed value. At most one live `CLEANUP` key exists; a second is refused by the constraint `api_keys_one_cleanup_uq`, mapped to `cleanup_exists` in `server/db/constraint-errors.ts` with a field error. The secret follows every existing rule (encrypted at rest, write only, never read back). There is no save time test call, because it would fire the automation (unlike the Cloudflare token check).
- **AC-2**: With a live `CLEANUP` key, cancelling a booking that is Current by the database clock (`status = confirmed`, `starts_at <= now() < ends_at`) queues one `cleanup_notify` job with event `booking.ended_early`, in the same transaction as the cancel. This holds for every cancel source (learner, admin, deactivation). Cancelling an Upcoming booking queues nothing.
- **AC-3**: With a live `CLEANUP` key, rescheduling a Current booking queues one `cleanup_notify` job with event `booking.moved` naming the old testbed and the old times, in the same transaction. Rescheduling an Upcoming booking queues nothing.
- **AC-4**: With no live `CLEANUP` key, nothing is queued, and cancel and reschedule behave exactly as before.
- **AC-5**: The worker sends `POST` with a JSON body (the shape in Feature design), a 5 second timeout, and no redirect following, to the key's Base URL. Headers: `X-HOL-Event`, `X-HOL-Delivery` (the job id, the same on every retry), `X-HOL-Timestamp` (unix seconds), and `X-HOL-Signature: sha256=<hex>`, an HMAC SHA256 of `<timestamp>.<raw body>` under the key's secret.
- **AC-6**: A `2xx` reply finishes the job. A network error, a timeout, `408`, `429`, or `5xx` retries with the existing job backoff (at most 8 attempts). Any other reply, including a redirect, is final for that job. A decrypt or keyring failure is final with reason `config`. A failure never changes, delays, or rolls back the booking.
- **AC-7**: When a job ends in failure (a final reply, attempts used up, or a job `sweepExhausted` fails), the worker writes a `cleanup_hook.failed` audit row (system actor, target type `booking`, target id the booking id, metadata `{ event, reason }` where reason is one of `timeout`, `network`, `status_4xx`, `status_5xx`, `redirect`, `config`, `stale`, `crashed`) and sets `api_keys.cleanup_failed_at`, which shows the same Needs attention badge on the API Keys row that a Google key gets. Both are written after the job's own transaction (the way `markGoogleRejected` does), using `finishJob`'s `failed` status as the signal. The mark is guarded by the key's id and a stamp of its URL and secret, so a failure under an old config never marks a key saved since. A later `2xx`, or a save that changes the key, clears it; a save that changes nothing does not. `cleanup_failed_at` is not audited.
- **AC-8**: One booking change queues at most one job (idempotency key `cleanup:<booking id>:<version>`), so a repeat queue adds nothing.
- **AC-9**: The secret never appears in a log, a job payload, `last_error`, an error message, audit metadata, a client payload, or a page. The URL is treated as a secret too (an n8n webhook path is a capability): it never appears in a log, a job payload, `last_error`, or audit metadata (the key update diff leaves `baseUrl` out for a `CLEANUP` key), and the API Keys list and edit form show it masked. The secret is decrypted only inside `server/catalog/api-keys.ts` (`cleanupHookConfig`), and `tests/secret-column-scan.test.ts` still passes.
- **AC-10**: The worker reads the live key at send time. If the key was deleted after the job was queued, the job finishes `done` with no call, no audit row, and no mark. A key whose URL or secret was replaced, or deleted and added again as a new row, sends to the new config.
- **AC-12**: A job whose `occurredAt` is more than 30 minutes (spec 0020's hold) older than the database clock at send time finishes without a call and counts as a failure with reason `stale`, so a late retry can never reset a testbed the next learner has started on.
- **AC-13**: The worker has its own step, "cleanup hook", that runs before "jobs". It claims only `cleanup_notify` jobs and needs no Google key, and the existing jobs step never claims this kind, so a missing Google key, a tripped Google breaker, or an email backlog never delays the hook.
- **AC-11**: Nothing a learner sees changes: no new text, no new field in any booking reply, and cancel and reschedule results are the same as before this spec.

## Options considered

### Option 1: Job queue plus a signed call from the worker
A new `cleanup_notify` job is queued inside the booking transaction and the worker sends the signed POST. Config is a new API key type.

**Pros**:
- Reuses the queue, retry, backoff, and breaker machinery and the encrypted key store; no new infrastructure.
- Exists only if the booking change commits; a slow hook never touches the booking.

**Cons**:
- Delivery is at least once, so the receiver must tolerate a repeat (the delivery id lets it).

### Option 2: Call the URL inside the cancel or move request
Send directly from the web process after the update.

**Pros**:
- Fewest moving parts to read.

**Cons**:
- A slow or down hook delays or fails the learner's cancel, and a crash after commit loses the event. This breaks the rule that the web process never calls out for a booking.

### Option 3: The automation polls the database or an API
Expose cancelled and moved bookings for the automation to read.

**Pros**:
- No outbound call, no secret in the app.

**Cons**:
- Needs a new read API or database access for an external system, plus a poll delay, and it is the app that knows the exact moment.

## Decision

**Chosen option**: Option 1: Job queue plus a signed call from the worker

When a Current booking is cancelled or moved, queue a `cleanup_notify` job in the same transaction and let the worker send an HMAC signed POST to the URL held by a new `CLEANUP` API key.

**Implementation skills**: `kysely` (`mindrally/skills`, `.claude/skills/kysely/`) · `zod` (`pproenca/dot-skills`, `.claude/skills/zod/`) · `vitest` (`antfu/skills`, `.claude/skills/vitest/`)

## Rationale

Spec 0020 left the early end open because the app, not the automation, knows the exact moment. The queue gives that moment a durable, retried delivery without touching the booking, which matches the existing rule that the web process only queues and the worker calls out (`server/jobs/AGENTS.md`). A new API key type keeps the secret write only and rotatable from the console, as the Cloudflare key already is, so no new env var or table is needed. HMAC with a timestamp lets n8n or a script check the sender and reject replays, which a static token in a URL cannot.

The runner up was a static bearer token. It is easier to check in a no code tool, but a leaked proxy log line would leak the secret itself.

## Feature design

**Data model sketch** (migration `0017_cleanup_hook.sql`, no new table):
- `api_keys.type` CHECK gains `CLEANUP`. Partial unique index `api_keys_one_cleanup_uq` on `(type)` where `type = 'CLEANUP' and deleted_at is null`.
- `api_keys.cleanup_failed_at timestamptz null`, with a CHECK that only a `CLEANUP` key may set it (the `api_keys_google_fields_check` pattern). Changing a key's type away from `CLEANUP` also clears it.
- `jobs.kind` CHECK gains `cleanup_notify`. Payload `{ bookingId, event, oldTestbedId, oldStartsAt, oldEndsAt, occurredAt }` (ids and times only). Idempotency key `cleanup:<booking id>:<version>`.
- Audit action `cleanup_hook.failed` (the `AuditAction` enum only, no CHECK). Zod enums in `lib/db-enums.ts` (`ApiKeyType`, `JobKind`) updated with their `checkLists` entries.

**State transitions**: none. Booking statuses are unchanged. A job moves `pending` → `running` → `done` or `failed` as every job does.

**API surface**: no new endpoint. Changes to existing surfaces:

| Surface | Change | Key inputs | Auth | Key errors |
|---|---|---|---|---|
| Add and edit API key action | accepts type `CLEANUP` | name, type, baseUrl (https), secret (16+) | `requireAdmin()` | field errors on `baseUrl`, `secret`, `type` (second live key) |
| `cancelBooking` (`server/db/bookings.ts`) | queues a job when the booking was Current | existing | existing callers | none new |
| `rescheduleBooking` (same file) | reads the old row first, queues a job when it was Current | existing | existing callers | none new |
| Worker step "cleanup hook" (before "jobs") | claims `cleanup_notify` jobs with `claimJob`, runs the handler, then `finishJob` and `sweepExhausted` (which now also returns the ids and kinds it failed) | job payload, live key | worker only | outcomes per AC-6, AC-7, AC-12 |
| `cleanupHookOn(trx)` in `server/catalog/api-keys.ts` | an existence select of a live `CLEANUP` key (no decrypt, no lock), called only when the booking was Current, so every cancel caller (including `cancelLiveBookings`) is covered | none | server | none |

**Request sent by the worker**:

```
POST <key base URL>
Content-Type: application/json
X-HOL-Event: booking.ended_early | booking.moved
X-HOL-Delivery: <job id>
X-HOL-Timestamp: <unix seconds>
X-HOL-Signature: sha256=<hex HMAC of "<timestamp>.<body>">

{ "event": "...", "deliveryId": "<job id>", "occurredAt": "<ISO>",
  "booking": { "id": "...", "startsAt": "<old ISO>", "endsAt": "<old ISO>" },
  "testbed": { "id": "...", "name": "...", "domain": "..." } }
```

No learner name, email, or group name is sent.

**Value sourcing**:

| Action | Value produced / displayed | Source |
|---|---|---|
| Queue (cancel) | Whether the booking was Current | `(starts_at <= now()) as was_current` in the cancel's `returning`, the booking still `confirmed` and `ends_at > now()` (the database is the clock, never JS dates) |
| Queue (reschedule) | Old testbed, old start and end, whether Current | the row `rescheduleOwnBooking` already selects `FOR UPDATE` (its only caller), passed in; Current is `old.starts_at <= now()` evaluated in SQL |
| Queue | Idempotency key version | the version after the update, from `returning` |
| Queue | Whether to queue at all | a live `CLEANUP` key exists (a select on `api_keys`) |
| Queue | `occurredAt` | `dbNow()` from `server/db/bookings.ts` (the transaction's start, which is intended) |
| Send | Hook URL and secret | `cleanupHookConfig()` in `server/catalog/api-keys.ts`, read at send time |
| Send | Testbed name and domain | `testbeds` row for `oldTestbedId` at send time (the current name; a soft deleted testbed still has them; `domain` may be null and is sent as null) |
| Send | Timestamp header | `dbNow()` as unix seconds, set fresh on each retry (the delivery id stays the same) |
| Send | Whether the event is stale | `occurredAt` against `dbNow()` and the 30 minute `GAP_MS` hold |
| Send | Delivery id | the job's `id` |
| Failure | Reason class | derived from the outcome: the outcome class: `timeout`, `network`, `status_4xx` (a 408 or 429 that runs out of attempts), `status_5xx`, `redirect`, `config`, `stale`, `crashed` (a job `sweepExhausted` failed) |

**Key invariants**:
- The job exists if and only if the cancel or move commits, and only when the booking was Current at that moment.
- The web process never calls the hook; only the worker does.
- A stored secret never leaves `server/catalog/api-keys.ts` except as the signature.
- A failed hook never changes a booking.
- The job lease is well above the 5 second call timeout (checked against `claimJob`'s lease when building).

**Security model**: only an admin can add or change the key (`requireAdmin()`). The secret is encrypted with the existing keyring, bound to table, column, and row id, and write only. The body holds no personal data. The URL is admin supplied and `https` only; redirects are not followed, so the call goes only where the admin pointed it. DNS could still resolve it to a private or link local address from the worker; this is accepted because only admins set it and the body holds no personal data. The receiver should reject a timestamp older than about 5 minutes and an `occurredAt` older than a few minutes, and de-duplicate on `X-HOL-Delivery`. No compliance scope applies.

**Configuration required**: none in the environment. The owner saves a `CLEANUP` key in the console (URL plus signing secret) and builds the receiver.

**Critical test scenarios**:
- Cancel a Current booking with a live key → one `booking.ended_early` job; cancel an Upcoming one → none, verifies **AC-2**
- Reschedule a Current booking → one `booking.moved` job with the old testbed; an Upcoming one → none, verifies **AC-3**
- No live key → no job, cancel unchanged; key deleted after queueing → no call, verifies **AC-4**, **AC-10**
- Handler against a local test server: headers present, signature verifies with the secret, body matches, redirect not followed, verifies **AC-5**
- Replies 200, 429, 500, 404, 302 and a timeout → done, retry, retry, final, final, retry; booking untouched, verifies **AC-6**
- A final failure, an exhausted job, and a swept job each write `cleanup_hook.failed` and set `cleanup_failed_at`; a later 200 or a changing save clears it, verifies **AC-7**
- A job queued over 30 minutes ago finishes without a call as `stale`, verifies **AC-12**
- With no Google key or a tripped breaker, a queued hook job still runs; the jobs step never claims it, verifies **AC-13**
- Queue the same change twice → one job, verifies **AC-8**
- Scan: URL and secret absent from logs, payloads, audit, errors, and props; the secret scan passes, verifies **AC-9**
- Second live `CLEANUP` key refused; `http://` URL and a URL with a password refused; non admin refused, verifies **AC-1**
- Learner cancel and reschedule results identical to before, verifies **AC-11**

## Build plan

Build approach: Tracer Bullet. Prove one real thread (a Current cancel through to a signed POST), then thicken.

1. Migration `0017_cleanup_hook.sql`, the Zod enums (`ApiKeyType`, `JobKind`), `AuditAction`, and `npm run db:codegen`, satisfies **AC-1**, **AC-7**, **AC-8**
2. Key rules in `server/catalog/api-keys.ts` (https and secret length checks, one live key, `cleanupHookConfig`), the form option and copy, and the Needs attention badge for `cleanup_failed_at`, satisfies **AC-1**, **AC-9**
3. The thread: `cleanupHookOn` and `queueCleanupNotice` called from `cancelBooking` for a Current booking with a live key, the `cleanup_notify` handler (signed POST, 5 second timeout, no redirects), and the separate "cleanup hook" worker step (registered in `worker/index.ts`, the jobs step excluding this kind), satisfies **AC-2**, **AC-4**, **AC-5**, **AC-8**, **AC-10**, **AC-13**
4. The move path: `rescheduleBooking` reads the old row and queues `booking.moved`, satisfies **AC-3**
5. Outcomes and failure surfacing: retry or final per reply, the 30 minute stale cutoff, the audit row and guarded `cleanup_failed_at` written after the job's transaction (including the `sweepExhausted` path), cleared on success or a changing save, satisfies **AC-6**, **AC-7**, **AC-12**
6. Tests for every scenario above, plus a source scan that keeps the URL and secret out of logs and payloads, the masked URL in the list and edit form and the audit diff, and a check that learner replies are unchanged, satisfies **AC-9**, **AC-11**

## Consequences

**Positive**:
- The automation learns about an early end at the moment it happens, closing the gap spec 0020 left open.
- No new infrastructure, table, or env var; the secret is rotatable from the console.
- A broken hook can never block a learner.

**Negative / tradeoffs**:
- Delivery is at least once; the receiver must use `X-HOL-Delivery` to ignore a repeat.
- A hook that is down for the whole retry window, or a job older than 30 minutes, loses that event (it shows as a badge and an audit row, not a replay).
- `sweepExhausted` changes to return the rows it failed, and the worker gains a second job step.
- The normal end at `ends_at` is still the automation's own job; this spec adds no call for it.
- The URL is admin supplied and may point anywhere over https; only admins can set it.

**Neutral**:
- One migration with three small `ALTER`s on `api_keys` and `jobs`; the worker gains one handler.
- `server/jobs/AGENTS.md` and the API keys notes need a line each (via `/sync`).

## Follow-up

- [ ] Owner: build the receiver (n8n or a script) that checks `X-HOL-Signature` and de-duplicates on `X-HOL-Delivery`
- [ ] Owner: save the `CLEANUP` key in the console after the deploy that carries migration 0017
- [ ] Owner, after the deploy: run the three unticked steps in `verify.md` (a real signed POST from the worker to a receiver on a cancel and a move, the Needs attention badge after a failed call, and a learner cancel and reschedule looking unchanged)
- [ ] The `CLEANUP` database tests insert their own key, so they fail while a live `CLEANUP` key exists in the shared database; make them tolerate one before the owner saves the real key
- [ ] If a test button is ever wanted, add a signed `test` event in a new spec
- [ ] Notes for `server/jobs/AGENTS.md` (the new job kind) once built (via `/sync`)
