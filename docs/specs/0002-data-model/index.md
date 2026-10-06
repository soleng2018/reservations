# 0002. Data model for Nile HOL Reservations

**Date**: 2026-10-06
**Status**: In Progress

## Summary

This spec fixes the database tables every later feature builds on: people, the lab catalog (testbed types, testbeds, their clients, API keys), bookings, background jobs, email status, the audit log, rate limits, and stored integration secrets. The hard rules live in Postgres itself: a testbed can never be double booked, a learner can never hold two live bookings, and audit entries can never be edited. Catalog rows are soft deleted (hidden, not removed) so past bookings keep their history. Tables land in slices: the core booking tables now, the rest with the feature that first uses them, all built to this one target shape.

## Requirements

**User stories**:
- As a learner, I want the system to refuse a booking that clashes with someone else's, so that the testbed I get is really mine for my window.
- As an admin, I want deleting catalog items to be blocked while they are in use, and past bookings to keep showing what they used, so that history stays accurate.
- As the owner, I want rules that matter (no overlap, one live booking, unchangeable audit) enforced by the database, so that a code bug or a race cannot break them.

**Acceptance criteria**:
- **AC-1**: Two live bookings (status `provisioning` or `confirmed`) on the same testbed whose `[starts_at, ends_at)` ranges overlap are rejected by the database, including when two transactions insert at the same moment. Back to back bookings (one ends exactly when the next starts) are allowed.
- **AC-2**: A user cannot hold two live bookings. The booking transaction first marks that user's `confirmed` bookings whose `ends_at <= now()` as `completed`, so a learner whose lab just ended can book again at once.
- **AC-3**: `cancelled` and `completed` bookings never block a new booking (neither the overlap rule nor the one live booking rule).
- **AC-4**: Soft deleting a testbed type used by any non deleted testbed, an API key assigned to any non deleted testbed, or a testbed with a live booking whose `ends_at > now()` is refused, and the refusal lists the blocking rows by name. Bookings that reference soft deleted rows still join to their testbed, type, and clients.
- **AC-5**: Testbed type, testbed, and API key names are unique ignoring case among non deleted rows. A testbed slug is unique across all rows forever (soft deleted included) and never changes after creation.
- **AC-6**: A user email is unique ignoring case (`Priya@x.com` and `priya@x.com` are the same user).
- **AC-7**: Any `UPDATE` or `DELETE` on `audit_events` raises an error, whoever runs it.
- **AC-8**: API key secrets and integration secrets are stored only as `v1:` ciphertext (spec 0001), and no list or detail query that feeds a page selects `secret_ciphertext`.
- **AC-9**: The database rejects invalid values: `duration_value < 1`, an unknown status, role, kind, or type, `ends_at <= starts_at`, a booking start not on a :00 or :30 boundary, and partial cancel data (cancel fields are all set or all null, and only on `cancelled` rows).
- **AC-10**: From an empty `hol_app` schema, `npm run db:migrate` applies every migration as `hol_app`; every table has RLS enabled with no policies and no grants to InsForge roles; `server/db/types.ts` regenerates from the live schema with no hand edits.
- **AC-11**: A pure function derives a booking's displayed phase (`Upcoming`, `Current`, `Past`, `Cancelled`, and `Pending` for `provisioning`, which learners never see) from its stored status, times, and a given `now`, and is the only place that mapping lives.
- **AC-12**: Reschedule and cancel succeed only on a `confirmed` booking whose `ends_at > now()` and whose `version` matches what the user saw; every reschedule or cancel raises `version` by exactly one, enforced by a trigger.
- **AC-13**: A guest saga that crashes at any step leaves, after compensation or the sweeper, no `provisioning` booking, no Authentik user this saga created, and no orphan `users` row; a retry by the same email is not blocked by its own stale attempt.
- **AC-14**: A soft delete and a booking on the same testbed or type cannot both succeed when the booking would make the delete invalid (they serialize on row locks), and only a testbed with `authentik_group_pk` set can be booked.

## Decision

**Chosen option**: Option 1: a normalized relational model with database enforced invariants, soft deleted catalog, and tables landed per slice.

All app tables live in schema `hol_app`, use `uuid` keys, model status style values as `text` + `CHECK`, and enforce no overlap, one live booking, and append only audit inside Postgres.

**Implementation skills**: `kysely` (`mindrally/skills`, `.claude/skills/kysely/`) · `supabase-postgres-best-practices` (`supabase/agent-skills`, `.claude/skills/supabase-postgres-best-practices/`) · `zod` (`pproenca/dot-skills`, `.claude/skills/zod/`) · `vitest` (`antfu/skills`, `.claude/skills/vitest/`)

## Rationale

Reasoning and options: see [rationale.md](rationale.md).

## Feature design

### Conventions (every table)

- Primary key `id uuid primary key default gen_random_uuid()` (except `rate_limits` and `integration_secrets`, keyed by name).
- `created_at timestamptz not null default now()`; mutable tables also have `updated_at timestamptz not null default now()`, maintained by one shared trigger function `hol_app.set_updated_at()`.
- Status style columns are `text not null` with a `CHECK (col in (...))`. The same values are a Zod enum in `lib/`, and the Zod enum is what the app reads (kysely-codegen sees `string`).
- Foreign keys default to `ON DELETE RESTRICT`. The only exceptions are listed per table.
- Every table: `alter table ... enable row level security;` with no policies, and no grants beyond the owner `hol_app` (spec 0001).
- Index every foreign key column (Postgres does not do this automatically). The indexes are listed per table below.
- Times are `timestamptz`, stored UTC; DB `now()` is the clock (spec 0001).
- Every constraint and unique index has an explicit name `<table>_<what>` (e.g. `users_email_lower_uq`, `testbeds_slug_uq`, `testbed_types_name_lower_uq`). `mapConstraintError` maps by these names, so they are a contract: renaming one is a breaking change.
- Names and emails are trimmed: `CHECK (name = btrim(name) and name <> '')` on every `name`, and the same on `users.email`. Upserts use the expression target, e.g. `ON CONFLICT ((lower(email)))`.

### Data model sketch

**users** (learners and admins)
| Column | Type | Null | Notes |
|---|---|---|---|
| id | uuid | no | PK |
| role | text | no | `learner` \| `admin` |
| name | text | no | |
| company | text | yes | Learners give one; admins have none. Required for learners by the Zod form, not the DB. |
| email | text | no | Stored as entered. Unique index on `lower(email)`. |
| timezone | text | no | IANA name, e.g. `America/New_York`. Learner: chosen on the form. Admin: see Value sourcing. |
| status | text | no | `active` \| `deactivated`, default `active` |
| deactivated_at | timestamptz | yes | Set with status `deactivated`, cleared on reactivate. `CHECK ((status = 'deactivated') = (deactivated_at is not null))` |
| email_verified_at | timestamptz | yes | Gates showing lab links (scope). How it is set is feature 4's decision. |
| authentik_user_pk | integer | yes | Unique. Null until the saga creates or finds the Authentik user. Written in its own commit right after the Authentik call (see Guest saga data). |
| authentik_pending_saga | boolean | no | Default false. True while a guest saga that **created** this Authentik user has not yet confirmed its booking. Compensation and the sweeper delete the Authentik user and this row only when it is true. Lives here, not on the booking, so it survives the booking delete. |
| auth_user_id | text | yes | Unique. FK to `hol_auth."user"(id)` `ON DELETE SET NULL`. Added by feature 4's migration with the Better Auth tables. |
| created_at, updated_at | timestamptz | no | |

**testbed_types**
| Column | Type | Null | Notes |
|---|---|---|---|
| id | uuid | no | PK |
| name | text | no | Unique on `lower(name)` where `deleted_at is null` |
| duration_value | integer | no | `CHECK (duration_value >= 1)` |
| duration_unit | text | no | `hours` \| `days` |
| deleted_at | timestamptz | yes | Soft delete |
| created_at, updated_at | timestamptz | no | |

**api_keys** (stored only, nothing calls them yet)
| Column | Type | Null | Notes |
|---|---|---|---|
| id | uuid | no | PK |
| name | text | no | Unique on `lower(name)` where `deleted_at is null` |
| type | text | no | `IDP` \| `AI` |
| base_url | text | no | |
| secret_ciphertext | text | no | `CHECK (secret_ciphertext like 'v1:%')`. Never selected for display. |
| secret_updated_at | timestamptz | no | Shown instead of the secret; changes only on replace |
| deleted_at | timestamptz | yes | Soft delete |
| created_at, updated_at | timestamptz | no | |

**testbeds**
| Column | Type | Null | Notes |
|---|---|---|---|
| id | uuid | no | PK |
| name | text | no | Unique on `lower(name)` where `deleted_at is null` |
| slug | text | no | `testbeds_slug_uq` across all rows. `CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) <= 50)`. Set once at create; the Authentik group is `pod-<slug>`. A trigger rejects any change to it. On a collision (including a soft deleted testbed's slug) the create appends `-2`, `-3`, … until free; `slugify` falls back to `testbed` when the name has no usable characters, and cuts to 50 characters before the suffix. |
| testbed_type_id | uuid | no | FK `testbed_types` |
| idp_api_key_id | uuid | yes | FK `api_keys`. Added by feature 8's migration (`api_keys` does not exist before it). Must reference an `IDP` key (checked in the Server Action). |
| portal_url | text | no | Nile Portal |
| lms_url | text | no | |
| authentik_group_pk | uuid | yes | Null until the group is created (feature 9 saga). A testbed is **bookable** only when `deleted_at is null and authentik_group_pk is not null`. |
| deleted_at | timestamptz | yes | Soft delete |
| created_at, updated_at | timestamptz | no | |

Indexes: `(testbed_type_id)`, `(idp_api_key_id)` (with feature 8).

**testbed_clients**
| Column | Type | Null | Notes |
|---|---|---|---|
| id | uuid | no | PK |
| testbed_id | uuid | no | FK `testbeds` `ON DELETE CASCADE` (only reached if a testbed is ever hard deleted) |
| kind | text | no | `wired` \| `wireless` |
| name | text | no | |
| url | text | no | |
| position | integer | no | Display order, from 0. Unique `(testbed_id, position)` (also serves as the FK index). Saving the form replaces the testbed's client rows in one transaction. |
| created_at | timestamptz | no | |

**bookings**
| Column | Type | Null | Notes |
|---|---|---|---|
| id | uuid | no | PK. Also the ICS `UID` and the calendar mirror key (spec 0001). |
| user_id | uuid | no | FK `users` |
| testbed_id | uuid | no | FK `testbeds` |
| testbed_type_id | uuid | no | FK `testbed_types`. The type the learner booked, copied at book and reschedule (a testbed's type can be edited later). |
| starts_at | timestamptz | no | `CHECK (starts_at = date_bin('30 minutes', starts_at, timestamptz '2000-01-01 00:00:00+00'))` |
| ends_at | timestamptz | no | `CHECK (ends_at > starts_at)`. `starts_at` plus the type's duration, computed in the app. Never moved by cancel. |
| status | text | no | `provisioning` \| `confirmed` \| `cancelled` \| `completed` |
| version | integer | no | Default 1. Incremented on every reschedule and cancel. ICS `SEQUENCE`. |
| calendar_event_id | text | yes | Google event id of the shared calendar mirror |
| cancelled_at | timestamptz | yes | |
| cancelled_by_user_id | uuid | yes | FK `users`. Null when the system cancelled. |
| cancel_source | text | yes | `CHECK (cancel_source in ('learner', 'admin', 'deactivation'))` |
| created_at, updated_at | timestamptz | no | `created_at` also ages `provisioning` rows for the sweeper |

Constraints on `bookings` (names are the contract with `mapConstraintError`):
- `bookings_no_overlap`: `EXCLUDE USING gist (testbed_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&) WHERE (status in ('provisioning', 'confirmed'))`, which satisfies AC-1 (`btree_gist` is installed by `db/bootstrap.sql`).
- `bookings_one_live_per_user`: `UNIQUE INDEX ON bookings (user_id) WHERE status in ('provisioning', 'confirmed')`, which satisfies AC-2.
- `bookings_cancel_fields_together`: `CHECK ((cancelled_at is null) = (cancel_source is null))`; `bookings_cancel_only_when_cancelled`: `CHECK ((status = 'cancelled') = (cancelled_at is not null))`; `bookings_cancelled_by_needs_source`: `CHECK (cancelled_by_user_id is null or cancel_source is not null)`.
- `bookings_version_bump` trigger (`BEFORE UPDATE`): sets `version = old.version + 1` whenever `starts_at`, `ends_at`, `testbed_id`, or `status` changes (except `confirmed` → `completed` and `provisioning` → `confirmed`, which change no calendar event), so code can never forget it.
- Indexes: `(testbed_id, starts_at)`, `(user_id, starts_at desc)`, `(testbed_type_id)`, `(cancelled_by_user_id)`, `(ends_at) WHERE status in ('provisioning', 'confirmed')` for the completion sweep and reconciler, `(created_at) WHERE status = 'provisioning'` for the saga sweeper.

**jobs** (shape from spec 0001)
| Column | Type | Null | Notes |
|---|---|---|---|
| id | uuid | no | PK |
| kind | text | no | `CHECK` list grows per feature (e.g. `send_email`, `calendar_upsert`, `calendar_delete`) |
| payload | jsonb | no | Parsed with a per kind Zod schema |
| run_at | timestamptz | no | Default `now()` |
| status | text | no | `pending` \| `running` \| `done` \| `failed` |
| attempts | integer | no | Default 0, `CHECK (attempts between 0 and 8)` |
| locked_until | timestamptz | yes | Lease |
| last_error | text | yes | |
| idempotency_key | text | no | Unique |
| created_at, updated_at | timestamptz | no | |

Index: `(run_at) WHERE status = 'pending'`, plus `(locked_until) WHERE status = 'running'` for lease expiry.

**email_messages** (send status shown in the console)
| Column | Type | Null | Notes |
|---|---|---|---|
| id | uuid | no | PK |
| user_id | uuid | no | FK `users` |
| booking_id | uuid | yes | FK `bookings`. Null for the welcome email. |
| job_id | uuid | yes | FK `jobs` `ON DELETE SET NULL` (jobs are purged) |
| kind | text | no | `welcome` \| `booked` \| `rescheduled` \| `cancelled` \| `reminder` |
| to_address | text | no | |
| subject | text | no | |
| status | text | no | `queued` \| `sent` \| `failed` |
| booking_version | integer | yes | The booking's `version` this email describes. `CHECK ((booking_id is null) = (booking_version is null))`. Unique `email_messages_one_per_version_uq (booking_id, kind, booking_version) WHERE booking_id is not null`, so a retried job never makes a second row. Welcome: unique `(user_id) WHERE kind = 'welcome'`. |
| provider_message_id | text | yes | Gmail message id |
| sent_at | timestamptz | yes | |
| last_error | text | yes | Never contains tokens or secrets |
| created_at, updated_at | timestamptz | no | |

Indexes: `(user_id)`, `(job_id)`, `(created_at desc)` (`booking_id` is covered by the unique index).

**audit_events** (append only)
| Column | Type | Null | Notes |
|---|---|---|---|
| id | uuid | no | PK |
| actor_user_id | uuid | yes | FK `users`. Null for the system (worker). |
| action | text | no | Dotted name, e.g. `api_key.secret_replaced`, `testbed.deleted`, `user.deactivated`, `booking.cancelled`. A Zod union in code, no DB `CHECK`, so a new action needs no migration. |
| target_type | text | no | `testbed_type` \| `testbed` \| `api_key` \| `user` \| `booking` \| `authentik_group` |
| target_id | text | no | Our uuid, or an Authentik id |
| summary | text | no | Human readable line for the log view |
| metadata | jsonb | no | Default `{}`. Changed fields (old and new), never secret values or ciphertext. |
| created_at | timestamptz | no | |

Trigger `audit_events_append_only` `BEFORE UPDATE OR DELETE ... FOR EACH ROW` plus `BEFORE TRUNCATE ... FOR EACH STATEMENT` raises an exception (AC-7). This stops the app and any normal SQL; the owner role could still drop the trigger in a migration, which review catches. Indexes: `(created_at desc)`, `(target_type, target_id)`, `(actor_user_id)`.

**rate_limits**
| Column | Type | Null | Notes |
|---|---|---|---|
| bucket_key | text | no | e.g. `book:ip:<ip>`, `book:email:<lower email>` (email is PII, so rows are short lived) |
| window_start | timestamptz | no | Fixed window: `date_bin(<window>, now(), timestamptz '2000-01-01 00:00:00+00')`. Window per kind: IP 10 minutes (limit 5), email 1 hour (limit 3), per spec 0001. |
| count | integer | no | Incremented with `INSERT ... ON CONFLICT DO UPDATE ... RETURNING count`; over the limit means refuse |
| created_at | timestamptz | no | |

PK `(bucket_key, window_start)`. The worker deletes rows whose `window_start` is older than two of their windows (in practice, older than 2 hours) once a day.

**integration_secrets**
| Column | Type | Null | Notes |
|---|---|---|---|
| name | text | no | PK, `CHECK (name in ('gmail_refresh_token'))` |
| ciphertext | text | no | `CHECK (ciphertext like 'v1:%')` |
| created_at, updated_at | timestamptz | no | |

**Schema `hol_auth`**: Better Auth's generated `user`, `session`, `account`, `verification` tables, created by feature 4's migration (spec 0001). They are not modeled here; `users.auth_user_id` is the only link.

**Relationships**
| From | To | Cardinality | On delete |
|---|---|---|---|
| testbed_types | testbeds | 1:N | RESTRICT (soft delete in practice) |
| api_keys | testbeds (`idp_api_key_id`) | 1:N, optional | RESTRICT |
| testbeds | testbed_clients | 1:N | CASCADE |
| testbeds | bookings | 1:N | RESTRICT |
| testbed_types | bookings | 1:N | RESTRICT |
| users | bookings (`user_id`) | 1:N, at most 1 live | RESTRICT |
| users | bookings (`cancelled_by_user_id`) | 1:N, optional | RESTRICT |
| users | email_messages | 1:N | RESTRICT |
| bookings | email_messages | 1:N, optional | RESTRICT |
| jobs | email_messages | 1:N, optional | SET NULL |
| users | audit_events | 1:N, optional | RESTRICT (rows are never deleted) |
| hol_auth.user | users | 1:1, optional | SET NULL |

### State transitions

**booking.status**
- (insert) → `provisioning`: guest saga step 1, or a signed in learner booking (which may go straight to `confirmed` when no Authentik step is needed).
- `provisioning` → `confirmed`: saga step 3, as `UPDATE ... WHERE id = $1 AND status = 'provisioning'`. Zero rows updated means the sweeper already removed it: run compensation and report "try again".
- `provisioning` → (row deleted): saga compensation or the sweeper after 10 minutes by `created_at` (spec 0001). This is the only hard delete of a booking.
- `confirmed` → `confirmed` (trigger bumps version): reschedule. Same row, new `testbed_id` / `testbed_type_id` / `starts_at` / `ends_at` (recomputed from the chosen type's **current** duration) in one `UPDATE ... WHERE id = $1 AND status = 'confirmed' AND ends_at > now() AND version = $expected`. The exclusion constraint checks the new range atomically (a row never conflicts with its own old value). Zero rows means the booking changed or ended meanwhile: refuse with "this booking changed, reload".
- `confirmed` → `cancelled`: learner, admin, or deactivation; same guard (`status = 'confirmed' AND ends_at > now()`); sets `cancelled_at`, `cancel_source`, `cancelled_by_user_id` (trigger bumps version). A Current booking keeps its `ends_at`; access ends because the status is no longer live.
- `confirmed` → `completed`: the worker each tick, or `completeEndedForUser` inside the booking transaction (AC-2), only for `status = 'confirmed' AND ends_at <= now()`. Never touches `provisioning`.
- `cancelled` and `completed` are final; reschedule and cancel refuse them (and `provisioning`).

**Guest saga data** (spec 0001's saga, the rows it writes):
1. Transaction 1: find or create `users` by `lower(email)` (`INSERT ... ON CONFLICT ((lower(email))) DO NOTHING`, then select). An existing `admin` row or a `deactivated` row is refused with the generic error. If that user already has a stale `provisioning` booking older than 1 minute (their own earlier attempt that crashed), delete it inside this transaction and run its compensation afterwards, so a retry is not blocked by `user_has_live_booking` for 10 minutes. Then insert the booking as `provisioning`.
2. Authentik find or create by email. Right after, in its own commit: set `users.authentik_user_pk`, and set `authentik_pending_saga = true` only if this call **created** the user.
3. Transaction 3: confirm the booking (guarded as above) and set `authentik_pending_saga = false`.

Compensation (in line or by the sweeper): delete the `provisioning` booking; if `authentik_pending_saga` is true and the user has no other booking, delete the Authentik user and then the `users` row. A user row created in step 1 whose Authentik call never succeeded (pk still null, no bookings) is deleted too.

**Catalog delete vs booking race**: the soft delete transaction does `SELECT ... FOR UPDATE` on the target row, runs the blocker query, then sets `deleted_at`. The booking and reschedule transactions do `SELECT ... FOR SHARE` on the chosen testbed and its type and recheck that it is bookable. A delete and a booking on the same testbed are therefore serialized.

**Displayed phase** (AC-11, `lib/booking-phase.ts`, pure): `cancelled` → Cancelled; `completed`, or `confirmed` with `ends_at <= now` → Past; `confirmed` with `starts_at <= now < ends_at` → Current; `confirmed` with `now < starts_at` → Upcoming; `provisioning` → Pending (never shown to learners, visible to admins only).

**user.status**: `active` ⇄ `deactivated` (admin only; side effects are feature 10's).

**job.status**: `pending` → `running` → `done`, or back to `pending` with backoff, or `failed` after 8 attempts (spec 0001).

**email_messages.status**: `queued` → `sent` | `failed` (a retry that later succeeds moves `failed` → `sent`).

### API surface

This feature adds no routes or Server Actions. Its surface is the schema plus these shared modules, which later features call:

| Module / function | Signature | Used by | Errors |
|---|---|---|---|
| `lib/booking-phase.ts` `bookingPhase` | `(b: { status, startsAt, endsAt }, now: Date) => 'Upcoming' \| 'Current' \| 'Past' \| 'Cancelled' \| 'Pending'` | every booking view, emails | none (pure, exhaustive switch) |
| `lib/duration.ts` `durationMs` | `(value: number, unit: 'hours' \| 'days') => number` (a day is a fixed 24 hour block in UTC, not a calendar day, so DST never changes a booking's length) | slot math, `ends_at` | throws on value < 1 (bug) |
| `lib/slug.ts` `slugify` | `(name: string) => string` | testbed create | none |
| `lib/db-enums.ts` | Zod enums for every `CHECK` list | Server Actions, codegen narrowing | none |
| `server/db/constraint-errors.ts` `mapConstraintError` | `(e: unknown) => Result<never, 'overlap' \| 'user_has_live_booking' \| 'duplicate_name' \| 'duplicate_email' \| 'duplicate_slug' \| 'in_use'>` | every write | rethrows unknown errors |
| `server/db/delete-blockers.ts` | `testbedTypeBlockers(db, id)`, `apiKeyBlockers(db, id)`, `testbedBlockers(db, id)` each `=> Promise<readonly { id, label }[]>` | features 7, 8, 9 | none |
| `server/db/bookings.ts` `completeEndedForUser` | `(trx, userId) => Promise<void>` (only `confirmed` rows) | every booking transaction (AC-2) | none |
| `server/db/bookings.ts` `lockBookableTestbed` | `(trx, testbedId) => Promise<Result<Testbed, 'not_bookable'>>` (`FOR SHARE`, checks not deleted and group set) | booking, reschedule (AC-14) | none |
| `server/db/delete-blockers.ts` callers | lock the target `FOR UPDATE` before calling a blocker query | features 7, 8, 9 (AC-14) | none |

`mapConstraintError` maps by constraint name (Postgres `23P01` exclusion, `23505` unique, `23503` FK) so the error text never leaks to users.

### Value sourcing

| Action | Value | Source |
|---|---|---|
| Book | `ends_at` | `starts_at` + `durationMs(type.duration_value, type.duration_unit)` at booking time |
| Book | `testbed_type_id` | The chosen type (input), equal to the assigned testbed's current type |
| Book / reschedule / cancel | `version` | Column: 1 on insert, bumped by the `bookings_version_bump` trigger |
| Reschedule / cancel | `$expected` version | The `version` the page rendered, sent as a hidden form field |
| Book (guest) | `authentik_pending_saga` | Saga step 2 result: true only when Authentik reported the user as newly created |
| Email row | `booking_version` | The booking's `version` read by the job handler when it renders |
| Any view | Displayed phase | `bookingPhase(row, now)`, `now` from the server clock at request time |
| Learner view | Times in learner zone | `users.timezone` (Step 1 form input) |
| Admin view | Times in admin zone | `users.timezone` of the admin row. Set at first sign in to `UTC`, then overwritten on the first console load from the browser's `Intl.DateTimeFormat().resolvedOptions().timeZone`. Feature 4 builds it. |
| Lab links shown | Verified flag | `users.email_verified_at` (set per feature 4) |
| Delete blocked dialog | Blocking names | `delete-blockers.ts` queries |
| Pod group name | `pod-<slug>` | `testbeds.slug` |
| API key list | Masked secret, last changed | Fixed mask in the UI, `secret_updated_at` |
| Cancel email | Who cancelled, wording | `cancel_source` |
| Audit entry | Actor, target, time | Session user (`require.ts`), action input, `created_at` |

### Key invariants

- No two live bookings on one testbed overlap (DB exclusion constraint).
- A user has at most one live booking (DB partial unique index); stale live rows are completed inside the booking transaction before the insert.
- A testbed slug never changes and is never reused (unique across all rows plus an update trigger).
- `audit_events` is append only (DB triggers).
- `bookings.version` changes only through its trigger, by exactly one per reschedule or cancel.
- Only a testbed that is not deleted and has its Authentik group can take a booking, checked under a `FOR SHARE` lock.
- Secrets are only ever stored as `v1:` ciphertext and never selected into page data.
- Soft deleted catalog rows are excluded from every list and picker, but stay joinable from bookings.
- Every `CHECK` list matches exactly one Zod enum in `lib/db-enums.ts` (a unit test compares them against `information_schema`).

### Security model

- Only the `hol_app` role (owner) touches these tables; RLS is enabled with no policies and InsForge's `anon`, `authenticated`, and `project_admin` have no grants; both schemas are in `insforge.internal_schemas` (spec 0001).
- Authorization (who may read or write which row) lives in Server Actions through `server/auth/require.ts` (feature 4), not in the DB: learners read only their own `users` row and bookings; admins read and write the catalog, learners, and bookings, and read `audit_events` and `email_messages`.
- PII: learner name, company, email, timezone. Kept for the life of the product (owner choice); no compliance regime has been named. `audit_events.metadata` and `email_messages.last_error` must never hold secrets or tokens.

### Configuration required

None new. Uses the existing `DATABASE_*` settings and `btree_gist` from `db/bootstrap.sql`.

### Critical test scenarios

- Happy path: from an empty schema, migrate, insert a type, a testbed with two clients, a learner, and a confirmed booking; regenerate types with no diff. Verifies **AC-10**.
- Concurrency: two transactions insert overlapping live bookings on one testbed at once; exactly one commits, the other gets `overlap`. Back to back succeeds. Verifies **AC-1**.
- One live: a second live booking for the same user fails with `user_has_live_booking`; after the first's `ends_at` passes, `completeEndedForUser` then insert succeeds. A cancelled booking blocks nothing. Verifies **AC-2**, **AC-3**.
- Blockers: soft deleting a type used by a testbed returns that testbed; after soft deleting a testbed with only Past bookings, those bookings still join. Verifies **AC-4**.
- Uniqueness: `Lab A` vs `lab a` is rejected while both are live and allowed once one is soft deleted; a reused slug is rejected; `Priya@x.com` vs `priya@x.com` is rejected. Verifies **AC-5**, **AC-6**.
- Audit: `UPDATE` and `DELETE` on `audit_events` raise. Verifies **AC-7**.
- Secrets: plain text in `secret_ciphertext` is rejected; the API key list query's selected columns exclude it. Verifies **AC-8**.
- Checks: each invalid value in AC-9 is rejected. Verifies **AC-9**.
- Phase: table driven unit test of `bookingPhase` at boundaries (`now` equal to `starts_at` and `ends_at`), and `provisioning` → Pending. Verifies **AC-11**.
- Reschedule guard: a stale `version`, a `completed` row, or an ended `confirmed` row updates zero rows; a good reschedule raises `version` by one through the trigger. Verifies **AC-12**.
- Saga: simulate a crash after step 1 and after step 2 (created and reused Authentik user); run compensation; assert no booking, the right `users` row state, and that a same email retry succeeds. The Authentik call is a stubbed boundary here; the real call is feature 6's test. Verifies **AC-13**.
- Delete race: one connection holds `FOR UPDATE` on a testbed while another tries `lockBookableTestbed`; the booking waits, then sees it deleted. A testbed with no group is not bookable. Verifies **AC-14**.
- Grants: for every table in `hol_app`, `information_schema.role_table_grants` lists only `hol_app`, and `relrowsecurity` is true (this test runs again as each later migration lands). Verifies **AC-10**.

DB integration tests run against the shared database (spec 0001: one data set), so every test runs inside a transaction that is always rolled back, and never commits. The concurrency test uses two connections and rolls back both.

## Build plan

Tracer Bullet: the core tables land now as slice 1's thread; every other table lands, in this exact shape, in the migration of the feature that first uses it.

1. [x] Migration `0001_core.sql`: `set_updated_at()` function, `users`, `testbed_types`, `testbeds` (without `idp_api_key_id`, with the slug immutability trigger), `testbed_clients`, `bookings` (named exclusion constraint, one live index, cancel checks, version bump trigger), `jobs`; RLS on every table; every named constraint and listed index. Satisfies **AC-1**, **AC-2**, **AC-3**, **AC-5**, **AC-6**, **AC-9**, **AC-10**, **AC-12**
2. [x] Run `npm run db:migrate` (after `pg_dump`), then generate `server/db/types.ts` with kysely-codegen (add a `db:codegen` script if missing); add the grants and RLS test. Satisfies **AC-10**
3. [x] `lib/db-enums.ts`, `lib/booking-phase.ts`, `lib/duration.ts`, `lib/slug.ts` with plain unit tests, plus the enum vs `CHECK` parity test. Satisfies **AC-5**, **AC-9**, **AC-11**
4. [x] `server/db/constraint-errors.ts` and `server/db/bookings.ts` (`completeEndedForUser`, `lockBookableTestbed`, guarded reschedule and cancel updates), with rolled back DB integration tests for overlap (including two connections), one live, cancelled not blocking, and the reschedule guard. Satisfies **AC-1**, **AC-2**, **AC-3**, **AC-12**, **AC-14**
5. [x] `server/db/delete-blockers.ts` for types and testbeds with the `FOR UPDATE` caller pattern, with integration tests including Past bookings still joining after soft delete and the delete race. Satisfies **AC-4**, **AC-5**, **AC-14**
6. [x] `server/db/guest-saga.ts` data steps (find or create user, take over a stale own attempt, record Authentik pk and the pending flag, guarded confirm, compensation query) with a stubbed Authentik boundary and crash simulations. Feature 6 wires the real Authentik call into it. Satisfies **AC-13**
7. With feature 4: migration adding the Better Auth `hol_auth` tables and `users.auth_user_id`. Satisfies **AC-10**
8. With feature 8: migration `api_keys` plus `testbeds.idp_api_key_id`, plus `apiKeyBlockers` and the secret column tests. Satisfies **AC-4**, **AC-5**, **AC-8**
9. With the first feature that rate limits guest booking (6 or 12): migration `rate_limits`. Satisfies **AC-10**
10. With feature 15: migration `email_messages` and `integration_secrets`. Satisfies **AC-8**, **AC-10**
11. With feature 18: migration `audit_events` and its append only and truncate triggers, with the trigger test. Satisfies **AC-7**

Feature 3 is done when tasks 1 to 6 ship; tasks 7 to 11 are owned and checked by their features, built to this spec.

## Consequences

**Positive**:
- Double booking and two live bookings are impossible even under races or app bugs.
- History survives catalog deletes without copying data into bookings.
- Every later table is already designed, so later migrations only add, never reshape.

**Negative / tradeoffs**:
- Soft delete means every catalog query must filter `deleted_at is null`; a missed filter shows ghost rows. Mitigation: query helpers in `server/db/` apply it, and lists are tested.
- A booking can stay `confirmed` after it ends until the next worker tick (about 30 seconds). Nothing breaks: phase is derived from time, and the booking transaction completes stale rows itself.
- The `CHECK` lists and the Zod enums are two copies of the same truth, kept in sync by the parity test.
- Tests run against the shared production database (spec 0001); a test that commits by mistake writes real data. Rolled back transactions are mandatory.
- The append only trigger also blocks the owner from fixing a bad audit row from the app; corrections are new entries.

**Neutral**:
- Adding a status value means a migration that swaps a `CHECK`, plus a Zod enum change.
- `testbed_clients` are replaced as a set on save, so their ids are not stable across edits (nothing references them).

## Follow-up

- [ ] Feature 4: decide how `email_verified_at` is set from Authentik, and create the admin `users` row (role `admin`) at first sign in, linked through `auth_user_id`. Recommended rules to settle there: link to an existing `users` row by email only when Authentik reports the email verified (otherwise an unverified address could take over a learner row); refresh `role` from the groups claim on every sign in; set the admin `timezone` from the browser on the first console load and only when it is still `UTC` (an admin changing it later wins).
- [ ] Feature 9: a testbed delete saga that removes the Authentik group, plus a sweeper for a group that failed to delete.
- [ ] Feature 6 / 12: decide which one first adds Turnstile and the rate limit table (build plan task 8).
- [ ] Feature 9: the testbed create saga sets `authentik_group_pk`; decide its sweeper for a testbed whose group was never created.
- [ ] Feature 17: the reminder will be a `jobs` row keyed by `reminder:<booking id>:<version>`, so a reschedule makes the old reminder stale by version; confirm in that spec.
- [ ] Spec 0001 lists the skills under `.agents/skills/`, while `AGENTS.md` lists `.claude/skills/`; `/sync` should reconcile the path.
