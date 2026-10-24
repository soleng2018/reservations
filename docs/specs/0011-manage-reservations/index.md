# 0011. Manage reservations: sign in, cancel, and reschedule

**Date**: 2026-10-12
**Status**: Accepted

## Summary

A signed in learner gets a real "Manage your reservation" area at `/reservations`: every Current, Upcoming, and Past booking as a card, a Cancel button, and a Reschedule button that opens the same calendar and confirm screens `/book` uses, now on their own page. A cancel or reschedule changes the one existing booking row in place, inside one locked transaction, so it either fully happens or leaves the original untouched; the worker then moves lab access on its next tick. A learner who is signed in and has nothing active can book again from `/book`, with their account details filled in and only the lab type left to pick. There is no database migration, no new env, and no new tool.

## Requirements

**User stories**:
- As a learner, I want to see all my reservations with their status in my own timezone, so that I know what I have and when.
- As a learner, I want to cancel an Upcoming or Current reservation in two clicks, so that the testbed goes back to others at once.
- As a learner, I want to move my reservation to another free time of the same lab, and either get the new time or keep the old one, so that I never end up with nothing.
- As a returning learner with nothing active, I want to book again without typing my details, so that booking takes one choice.
- As the owner, I want every learner change audited and every Past booking frozen, so that the history stays trustworthy.

**Acceptance criteria**:
- **AC-1**: A signed in active learner at `/reservations` sees the heading "Welcome back, <first name>" (the first word of the trimmed `users.name`), the line "Here's everything on your account." followed by the AC-2 link or note, then one card per booking of theirs with status `confirmed` or `completed`. Cancelled and provisioning rows never show. Order: Current first, then Upcoming by `starts_at` ascending, then Past by `starts_at` descending. Each card shows the testbed name, the phase badge (`bookingPhase` with `dbNow`, tone from `toneFor`), the lab type name, and "<start> → <end>" with `formatDateTime` in `users.timezone` (each time carries its own zone abbreviation, so cards on either side of a DST change read correctly); testbed and type names show even when soft deleted. Under the list, a note reads "Times in <zone name>." (the IANA zone with underscores as spaces, no offset, since one offset would be wrong for some cards). Upcoming and Current cards show "Reschedule" (only when reschedulable, AC-6) and "Cancel reservation"; an Upcoming or Current card that is not reschedulable shows only Cancel plus the note "This lab type can't be rescheduled right now." Past cards show no action (feature 14 adds "View lab access"). With no cards the list shows "No reservations yet." The page writes nothing (no `completeEndedForUser` on read).
- **AC-2**: "Reserve another lab →" (a link to `/book`) shows only when the learner has no `provisioning` booking created within `STALE_OWN_ATTEMPT` (the same 1 minute the Step 1 check and the saga use; an older one is a crashed attempt the saga replaces), and none `confirmed` with `ends_at > now()`. Otherwise the line ends with "You have an active reservation. Finish it before booking another." (the scope's one active booking rule, stricter than the mock, which checks Current only).
- **AC-3**: `/reservations` keeps spec 0003's behavior for everyone else: anonymous visitors get the sign in card with the resend set password form; a signed in admin is redirected to `/admin`; a deactivated user is redirected to `/auth/error?reason=deactivated`. A deactivated learner cannot sign in (spec 0003 AC-9, checked again here end to end).
- **AC-4**: "Cancel reservation" opens a confirm dialog (shadcn `AlertDialog`): title "Cancel this reservation?", body "This will free up <testbed> on <start>." plus " Your lab access ends within a minute. Close any open lab tabs." for a Current booking (the second sentence added by spec 0012 AC-13 on 2026-10-15), buttons "Keep it" and "Cancel reservation". Confirming calls `cancelReservationAction` with the booking id and version bound by the page. One transaction: lock the learner's `users` row `FOR SHARE` with `status = 'active'` (else `stale`; deactivation holds `FOR UPDATE` on that row, so the two run one after the other); lock the booking `FOR UPDATE` where `id` matches, `user_id` is the session learner, `status = 'confirmed'`, `ends_at > now()`, and `version` matches; run `cancelBooking` with `source = 'learner'` and `byUserId` the learner; write `booking.cancelled` (AC-17); commit. Then `revalidatePath('/reservations')` and the toast "Reservation cancelled." The card disappears, and the AC-2 link appears when nothing else is live. A Current booking keeps its `ends_at` (spec 0002). An Upcoming booking can be cancelled right up to its start, including inside the 1 hour lead time. A thrown action or a network failure shows the error toast "Something went wrong. Try again." and changes nothing on screen. No email is sent (feature 15).
- **AC-5**: A cancel whose lock finds no row (a stale version, a booking that ended, was cancelled, or was rescheduled meanwhile, or an id that is not the learner's) writes nothing, revalidates, and shows the error toast "This reservation already changed. The list has been refreshed." A booking id owned by another learner gets exactly this reply, so the action reveals nothing about it. Past bookings can never be cancelled or rescheduled, because both guards require `ends_at > now()`.
- **AC-6**: "Reschedule" links to `/reservations/<id>/reschedule`. The page calls `requireLearner()` and loads the booking by id and session learner. A malformed id, an unknown id, or another learner's booking (`ownReschedulable` returns `missing`) renders `notFound()`. A booking of theirs that is no longer `confirmed` with `ends_at > now()`, or is not reschedulable (`unavailable`), renders a card "This reservation can't be rescheduled any more." with "Back to your reservations". Reschedulable means: the booking's type is not deleted, and `bookableTestbedsOfType` for it is not empty. The list (AC-1) uses the same rule.
- **AC-7**: Step 2 of the reschedule page: eyebrow "Reschedule", title "Choose a time", subtitle "<type> · <duration>" with the type's current duration. It reuses `TimeStep` with starts from `loadRescheduleStartsAction(bookingId)`: the type's free starts by spec 0010 rules (`LEAD_MS`, `HORIZON_MS`, half hour grid, DB `now()`), where this booking's own range never counts as busy. The booking's current start shows with the label "Current" and is disabled, even when otherwise free. The calendar opens on the month of the current start when that month is in range, else as on `/book`, with no day picked (`day` starts null) and the prompt "Select a date to see available start times." A booking whose own start is inside the 1 hour lead time can still be moved; only the new start must be offerable. Back goes to `/reservations`. Spec 0010 AC-6 freshness applies unchanged (reload on entry, after `slot_taken`, and on refocus when older than 5 minutes; a dropped pick shows "That time is no longer available. Please pick another."). A type with no free start shows "No free times in the next 90 days." and Back. A `gone` reply (the booking changed meanwhile) goes to `/reservations` with the AC-5 toast.
- **AC-8**: Step 3: eyebrow "Reschedule", title "Confirm your new time", rows Email, Lab type, Timezone (`zoneLabel(timezone, pickedStart)`), then "Current time" (the old start by `formatDateTime` in the account zone, whose own EDT or EST style suffix covers a DST change; muted and struck through), a divider, then Starts, Ends, and Testbed assigned (accent). For a Current booking a note under the card reads "Your current lab session ends when you confirm." On entry it calls `previewRescheduleAction(bookingId, startsAt)`: the booking's own testbed when it is still bookable and free at the new range, else the first free bookable testbed in `lower(name)` order, ignoring this booking's own range. `taken` sends the learner back to Step 2 with the AC-7 message and a reload; `limited`, a thrown action, or a network failure shows "Assigned when you confirm" and the end from `durationMs`; `gone` behaves as in AC-7. Ends always comes from the preview's `endsAt` or the starts reply's `durationMs`, never from the page props, so an admin's duration change shows here. Buttons: Back (to Step 2, pick kept) and "Confirm new time", disabled while a submit runs. No Turnstile (the learner is signed in).
- **AC-9**: `rescheduleAction(bookingId, version, startsAt)` runs `requireLearner()`, then the per user bucket (AC-14), then parses (`z.uuid()`, a positive integer, an ISO datetime), then one transaction: (0) lock the learner's `users` row `FOR SHARE` with `status = 'active'`, else `stale` (serializes with deactivation, as in AC-4); (1) lock the booking `FOR UPDATE` by id, session learner, `confirmed`, `ends_at > now()`, and version, else `stale`, except that a booking of theirs that is `confirmed` with `starts_at` equal to the requested start and `version = expected + 1` returns `rescheduled` with its current values (a Try again after a lost reply whose first try committed); (2) read its type (the locked row's `testbed_type_id`) `FOR SHARE`, not deleted, else `unavailable`; (3) `endsAt = startsAt + durationMs(type)` with the type's current duration; a start equal to the current `starts_at` gives `same_time` (checked first, so a Current booking's past start reads as its own time); then `isOfferableStart(startsAt, dbNow, LEAD_MS, HORIZON_MS)` else `slot_taken`; (4) candidates are the booking's own testbed first when it is among `bookableTestbedsOfType`, then the rest in `lower(name)` order; for each, `lockBookableTestbed`, then a read for any live booking on it overlapping `[startsAt, endsAt)` other than this one; the first with none is updated through `rescheduleBooking` (same id, `testbedTypeId` from the locked row, the new testbed, start, and end; the version trigger bumps `version`); when no candidate is free the saga's rule applies: `slot_taken` if any candidate passed `lockBookableTestbed`, else `unavailable`; (5) write `booking.rescheduled` (AC-17); commit. Outside the transaction, a `bookings_no_overlap` violation from a concurrent commit maps through `mapConstraintError` (`overlap`) to `slot_taken`, and a deadlock (`40P01`) or serialization failure (`40001`) also maps to `slot_taken`; anything else is rethrown. Note that `now()` in every guard is the transaction's start time. Every refusal or error rolls the whole transaction back, so the original booking is untouched. Reply: `{ kind: 'rescheduled', testbedName, typeName, startsAt, endsAt }` or `{ kind: 'error', code }` with `code` one of `limited`, `invalid`, `stale`, `slot_taken`, `same_time`, `unavailable`.
- **AC-10**: Confirm shows `ProgressScreen` with the title "Updating your reservation" and steps "Updating your reservation", "Reassigning your testbed", "Confirming your new time", on spec 0010's timers (the last ticks only on `rescheduled`). Routing by reply: `rescheduled` → success (AC-11); `slot_taken` → Step 2 with the AC-7 message, a reload, and the pick cleared; `same_time` → Step 2 with "That's already your reservation time. Please pick another."; `stale` → `/reservations` with the AC-5 toast; `limited` → Step 3 with "Please try again in a little while."; `invalid` and `unavailable` → the failure screen with "We couldn't change your reservation. Your original time is unchanged."; a thrown action or a network failure → the failure screen with "We couldn't confirm the change. Check your reservations to see your current time." and a link to `/reservations`. The failure screen has Back (to Step 3) and Try again (resubmits the same pick at the same version; if the first try had committed, AC-9 step (1) answers `rescheduled` and the success screen shows). Each submit carries an id, and only the latest reply applies. A redirect thrown by `requireLearner()` inside any action (session expired, deactivated) is never caught by the flow: Next.js navigates to the sign in or error page.
- **AC-11**: The success screen: check icon, "Your reservation has been rescheduled.", rows Testbed, Lab type, Starts, Ends in the account zone (from the `rescheduled` reply), and Done to `/reservations`. No calendar invite line, Add to calendar, View email (feature 15), or lab links (feature 14).
- **AC-12**: The reschedule page keeps the step in `?step=2|3`, so browser Back and Forward move between Step 2 and Step 3; progress, failure, and success add no history entry and ignore browser Back and Forward. Loading `?step=3` with no pick in memory replaces the URL with `?step=2`. A refresh at any point reloads the booking from the server (no learner data lives in browser storage).
- **AC-13**: `/book` with an active learner session (`currentSession()` with role `learner` and status `active`; the public page never calls `requireLearner()`, which would redirect) shows Step 1 as an account summary: "Booking as <name>" with Company (hidden when `users.company` is null), Email, and Timezone (`zoneLabel`) read only, and Lab type as the only input. The flow's details are seeded from the account, so Step 3 shows Name, Company (when set), Email, and Timezone from it, and Back from Step 2 returns to this summary. The flow posts `asAccount=1`. `checkDetailsAction` and `bookAction`, when they see an active learner session through `currentSession()`, parse only `testbedTypeId` (and `startsAt` for `bookAction`) and take name, company, email, and timezone from the session's `users` row as stored (not through `BookInput`, whose rules a stored null company or an admin edit could fail), so a crafted post cannot book under another email; the email bucket key uses the session email. When a post carries `asAccount=1` but no active learner session is found (signed out, expired, or deactivated meanwhile), both return the new code `signed_out`, shown in the Step 1 Alert as "You were signed out. Sign in again to book." with a link to `/reservations`; no guest booking runs. Every other check (the IP bucket, Turnstile, the saga) runs unchanged: booking makes Authentik calls, so Turnstile stays on this one shared path even for a signed in learner. The success screen for a signed in learner replaces the reused user line with a "View my reservations" link, and Done goes to `/reservations`. An admin, a deactivated user, or no session (without `asAccount`) gets today's guest Step 1. The Step 1 `has_live_booking` panel still links to `/reservations`.
- **AC-14**: Per user rate buckets, keyed by `users.id`, every attempt counted: `reschedule-starts:user:<id>` 60 per 600 s and `reschedule-preview:user:<id>` 60 per 600 s (over the limit, the AC-7 and AC-8 `limited` handling), `reschedule:user:<id>` 20 per 3600 s (over the limit, `limited`; sized so a learner retrying busy slots does not lock themselves out). Cancel has no bucket: it needs a live booking, of which a learner holds at most one, and a refused cancel writes nothing.
- **AC-15**: Every page and Server Action in this feature calls `requireLearner()` first: the `/reservations` list branch, `cancelReservationAction`, the reschedule page, `loadRescheduleStartsAction`, `previewRescheduleAction`, and `rescheduleAction`. None is on the public allow list in `tests/server-actions-require.test.ts`. Every booking read and write filters by `user_id` = the session learner. Replies carry only that learner's own data (ISO times, their testbed and type names, codes), never another learner's.
- **AC-16**: After a cancel or reschedule, the access reconciler converges group membership within two ticks (one normally; two when the change commits while a tick is running, since `reconcileAccess` reads the desired members once per run), about a minute, with no change to its code (desired members are active learners with a `confirmed` booking that is Current by the DB clock): cancelling a Current booking removes the learner from that testbed's Authentik group and ends their Authentik sessions; rescheduling a Current booking to a later start removes them the same way; a later reschedule that lands on another testbed adds them to the new group when it starts. Ending Authentik sessions does not end the learner's Better Auth session in the app, so they stay on `/reservations`.
- **AC-17**: Audit rows in the same transaction as each change, actor the learner, target type `booking`, target id the booking id: `booking.cancelled` (summary "Reservation cancelled", metadata `{ source: 'learner', userId, testbedId, phase }`, as spec 0008 AC-13) and the new `booking.rescheduled` (summary "Reservation rescheduled", metadata `{ fromStartsAt, toStartsAt, fromTestbedId, toTestbedId, phase }`, phase `Upcoming` or `Current` before the change). The admin user detail page shows a learner cancel as "by learner" (spec 0008 AC-2, existing).
- **AC-18**: The list (with Current, Upcoming, Past, and an unmovable card), the cancel dialog, reschedule Step 2 and Step 3, progress, failure, success, the "can't be rescheduled" card, and signed in `/book` Step 1 match the mock at desktop and mobile widths within `design.md`'s allowed differences, built from its tokens and components. Axe reports no violations on each, a keyboard alone completes a cancel and a reschedule, and screenshots of each are captured. Every page stays `noindex`.

## Decision

**Chosen option**: Option 1: change the one booking row in place under a lock, with a server loaded reschedule page that reuses the `/book` step components.

Cancel and reschedule are learner Server Actions that lock the learner's own booking, check the version the learner saw, and update that row in one transaction (reschedule through the existing `rescheduleBooking` guard and the overlap constraint), leaving lab access to the reconciler.

**Implementation skills**: `kysely` (`mindrally/skills`, `.claude/skills/kysely/`) · `supabase-postgres-best-practices` (`supabase/agent-skills`, `.claude/skills/supabase-postgres-best-practices/`) · `zod` (`pproenca/dot-skills`, `.claude/skills/zod/`) · `shadcn` (`shadcn-ui/ui`, `.claude/skills/shadcn/`) · `base-ui` (`itechmeat/llm-code`, `.claude/skills/base-ui/`) · `shadcn-baseui` (`thunderboltdev/shadcn-baseui`, `.claude/skills/shadcn-baseui/`) · `vercel-react-best-practices` (`vercel-labs/agent-skills`, `.claude/skills/vercel-react-best-practices/`) · `better-auth-best-practices` (`better-auth/skills`, `.claude/skills/better-auth-best-practices/`) · `vitest` (`antfu/skills`, `.claude/skills/vitest/`) · `playwright-best-practices` (`currents-dev/playwright-best-practices-skill`, `.claude/skills/playwright-best-practices/`)

## Rationale

Reasoning and options: see [rationale.md](rationale.md).

## Feature design

### Data model sketch

No migration. Every column and constraint used here exists (specs 0002, 0004, 0008):

| Table | Used for | Access |
|---|---|---|
| `bookings` | the list, cancel (`status`, `cancelled_at`, `cancel_source = 'learner'`, `cancelled_by_user_id`), reschedule (`testbed_id`, `starts_at`, `ends_at` in place), `version` guard (bumped by `bookings_version_bump`), `bookings_no_overlap` | read, update through `cancelBooking` and `rescheduleBooking` only |
| `users` | first name, `timezone`, `company`, `email` for signed in `/book` | read |
| `testbed_types`, `testbeds` | names (soft deleted included on the list), duration, bookable testbeds | read, `FOR SHARE` in reschedule |
| `rate_limits` | new buckets `reschedule-starts:user:<id>`, `reschedule-preview:user:<id>`, `reschedule:user:<id>` | write through `countAttempt` |
| `audit_events` | `booking.cancelled`, `booking.rescheduled` | insert through `audit()` |

Code only additions: `booking.rescheduled` in `AuditAction` (`lib/audit-actions.ts`; no DB CHECK, so no migration). `calendar_event_id` is left untouched (feature 15). `npm run db:codegen -- --verify` stays clean.

### State transitions

**booking.status** (spec 0002, unchanged): a learner moves `confirmed` (Upcoming or Current) to `cancelled`; a reschedule keeps `confirmed` and changes the time and maybe the testbed. `completed`, `cancelled`, and `provisioning` rows are never touched by this feature.

| From | Event | To | Guard |
|---|---|---|---|
| `confirmed`, `ends_at > now()` | learner cancel | `cancelled`, `cancel_source = 'learner'` | own booking, version matches |
| `confirmed`, `ends_at > now()` | learner reschedule | `confirmed` at the new range, `version + 1` | own booking, version matches, type live, start offerable, a free bookable testbed |
| anything else | either | unchanged | refused (`stale`) |

**The reschedule client flow** (`components/reservations/reschedule-flow.tsx`, one `useReducer`; the pure reducer goes in `lib/reschedule-flow.ts`). Screen = URL step (`time`, `confirm`) plus phase (`editing`, `progress`, `failure`, `success`). The Step 2 events (starts loaded, day picked, start picked, refocus reload after 5 minutes, a reload that drops the pick, an empty picked day) and their messages are the time slice of `lib/booking-flow.ts`, reused as is (extract that slice into a shared helper both reducers call, rather than copy it). The table lists only what differs:

| From | Event | To |
|---|---|---|
| `time` | starts `limited`, thrown, or network failure | `time` with Retry, pick kept |
| `time` | starts `gone` | navigate to `/reservations`, AC-5 toast |
| `time` | Continue with a pick | `confirm` (push `?step=3`) |
| `time` | Back | navigate to `/reservations` |
| `confirm` | preview `taken` | `time` with the AC-7 message and a reload |
| `confirm` | preview `limited`, thrown, or network failure | `confirm` with "Assigned when you confirm" |
| `confirm` | preview `gone` | navigate to `/reservations`, AC-5 toast |
| `confirm` | Confirm new time | phase `progress`, new submit id |
| `confirm` | Back or browser Back | `time` |
| `progress` | reply for an older submit id | ignored |
| `progress` | `rescheduled` | phase `success` (replace URL, drop `?step`) |
| `progress` | `slot_taken`, `same_time` | `time` with its message, reload, pick cleared |
| `progress` | `stale` | navigate to `/reservations`, AC-5 toast |
| `progress` | `limited` | `confirm` with the message |
| `progress` | `invalid`, `unavailable` | phase `failure` ("Your original time is unchanged.") |
| `progress` | thrown or network failure | phase `failure` ("Check your reservations...") |
| `failure` | Back | `confirm`, phase `editing` |
| `failure` | Try again | phase `progress`, new submit id |
| `success` | Done | navigate to `/reservations` |
| `confirm` | loaded with no pick in memory | `time` (replace URL with `?step=2`) |

### API surface

| Surface | Kind | Key inputs | Key outputs | Auth | Key errors |
|---|---|---|---|---|---|
| `/reservations` | Server Component (changed) | session | sign in card, or the learner list (AC-1, AC-2) | public sign in card; list needs an active learner session | admin → `/admin`; deactivated → error page |
| `cancelReservationAction` (`app/reservations/actions.ts`) | Server Action | `bookingId`, `version` (bound by the page) | `{ ok: true } \| { ok: false, error: 'stale' }`; revalidates `/reservations` | `requireLearner()` | `stale` (also for an unknown id, another learner's booking, or a learner deactivated meanwhile); a throw shows "Something went wrong. Try again." |
| `/reservations/[id]/reschedule` | Server Component | `params.id`, `searchParams.step` (client only) | booking summary props for the flow, or the "can't be rescheduled" card | `requireLearner()` | `notFound()` for malformed, unknown, or not theirs |
| `loadRescheduleStartsAction` (`app/reservations/[id]/reschedule/actions.ts`) | Server Action | `bookingId`: uuid | `{ starts, durationMs, now } \| { limited: true } \| { gone: true }` | `requireLearner()`; 60 per user per 10 min | `gone` when the booking is not the learner's live, reschedulable one |
| `previewRescheduleAction` | Server Action | `bookingId`: uuid, `startsAt`: ISO | `{ kind: 'ok', testbedName, endsAt } \| { kind: 'taken' } \| { kind: 'limited' } \| { kind: 'gone' }` | `requireLearner()`; 60 per user per 10 min | bad `startsAt` reads as `taken` |
| `rescheduleAction` | Server Action | `bookingId`: uuid, `version`: int, `startsAt`: ISO | `{ kind: 'rescheduled', testbedName, typeName, startsAt, endsAt } \| { kind: 'error', code: RescheduleErrorCode }` | `requireLearner()`; 20 per user per hour | `limited`, `invalid`, `stale`, `slot_taken`, `same_time`, `unavailable` |
| `/book` | Server Component (changed) | session via `currentSession()` | adds `account?: { name, company: string \| null, email, timezone }` for an active learner | public | none |
| `checkDetailsAction`, `bookAction` | Server Actions (changed) | as spec 0010, plus `asAccount` (`"1"` when the flow rendered with `account`) | as spec 0010 | public (allow list, unchanged) | as spec 0010, plus `signed_out`; for an active learner only the type (and start) are parsed, identity comes from the session row |

Modules:

| Module / function | Signature | Notes |
|---|---|---|
| `server/booking/manage.ts` (new) | `learnerBookings(conn, userId): Promise<readonly LearnerBookingRow[]>`; `hasLiveBooking(conn, userId): Promise<boolean>`; `ownReschedulable(conn, userId, bookingId): Promise<{ kind: 'missing' } \| { kind: 'unavailable' } \| { kind: 'ok'; booking: ReschedulableBooking }>`; `cancelOwnBooking(conn, userId, bookingId, version): Promise<Result<void, 'stale'>>`; `rescheduleOwnBooking(conn, userId, input: { bookingId, version, startsAt }): Promise<Result<Rescheduled, RescheduleRefusal>>` | Lock order in both writes: `users` row `FOR SHARE`, booking `FOR UPDATE`, type `FOR SHARE`, then each candidate testbed `FOR SHARE` (through `lockBookableTestbed`). All type and testbed locks are share locks, so only an admin soft delete (`FOR UPDATE`) waits on them. `cancelOwnBooking` follows `cancelBookingByAdmin` (lock, `cancelBooking`, audit inside `refusable()`). `rescheduleOwnBooking` is the AC-9 transaction; it throws `Refusal` for each refusal inside `refusable()`, and outside the transaction maps `overlap` from `mapConstraintError` and Postgres codes `40P01` and `40001` to `slot_taken` through a pure `toRescheduleError`. `learnerBookings` computes `reschedulable` in the same query (an `exists` over bookable testbeds of the type) for live rows only; `LearnerBookingRow` carries id, version, status, `startsAt`, `endsAt`, testbed and type names, and `reschedulable`. |
| `server/booking/availability.ts` (changed) | `startsFor(conn, typeId, opts?: { excludeBookingId?: string })`; `firstFreeTestbed(conn, typeId, startsAt, opts?: { excludeBookingId?: string; preferTestbedId?: string })`; `busyRanges` takes the same exclude | The spec 0010 follow up. `/book` callers pass no options, so their behavior is unchanged. |
| `lib/manage-reservations.ts` (new, pure) | `sortCards(rows, now)`, `cardActions(phase, reschedulable)`, `firstName(name)`, `preferFirst(candidates, preferId)` | `firstName` replaces the inline rule in `lib/booking-flow.ts`. `preferFirst` puts the kept testbed first and keeps the rest in their given order. |
| `lib/booking-input.ts` (changed) | `RescheduleErrorCode`, `RESCHEDULE_MESSAGES`; `BOOK_ERRORS` and the details code union gain `signed_out` | The AC-7, AC-8, AC-10, AC-13 copy, one place. |
| `lib/reschedule-flow.ts` (new, pure) | reducer, state, events | The transition table above; unit tested like `lib/booking-flow.ts`. |
| `lib/audit-actions.ts` | adds `booking.rescheduled` | |
| `app/reservations/page.tsx` (changed) | list branch | Replaces the placeholder. |
| `app/reservations/actions.ts` (changed) | adds `cancelReservationAction` | |
| `app/reservations/[id]/reschedule/page.tsx`, `actions.ts` (new) | as the API table | |
| `components/reservations/reservation-card.tsx`, `cancel-reservation-button.tsx`, `reschedule-flow.tsx`, `reschedule-success.tsx`, `cannot-reschedule.tsx` (new) | | The cancel button follows `components/admin/booking-cancel-button.tsx` (`AlertDialog`, toast through `notifySuccess` / `notifyError`). |
| `components/book/time-step.tsx` (changed) | adds optional `currentStart?: string` | Shows that slot as "Current" and disabled; opens on its month when in range. `/book` passes nothing. |
| `components/book/failure-screen.tsx` (changed) | adds `flow?: 'book' \| 'reschedule'` | Picks the AC-10 copy; the default stays `book`. |
| `components/book/details-step.tsx`, `booking-success.tsx`, `booking-flow.tsx`, `lib/booking-flow.ts` (changed) | take optional `account` | AC-13: the summary, details seeded from `account` (so the "no details in memory" fallback never fires for it), `asAccount` posted, the `signed_out` Alert, the success link, and the Done target. |

### Value sourcing

| Action | Value | Source |
|---|---|---|
| list | learner identity | `requireLearner()` session `users.id` (via `currentSession`) |
| list | first name | `firstName(users.name)` |
| list | cards | `bookings` where `user_id` = learner and `status in ('confirmed', 'completed')`, joined to `testbeds.name` and `testbed_types.name` (soft deleted included) |
| list | phase, order | `bookingPhase({ status, startsAt, endsAt }, dbNow)`; `sortCards` |
| list | start, end labels | `formatDateTime(<time>, users.timezone)` |
| list | "Times in" note | `users.timezone` with underscores as spaces, no offset |
| list | reschedulable | in the `learnerBookings` query, live rows only: type `deleted_at is null` and a testbed of the type with `deleted_at is null` and `authentik_group_pk is not null` (the `bookableTestbedsOfType` rule) |
| list | Reserve another shown | `hasLiveBooking`: a `provisioning` row with `created_at >= STALE_OWN_ATTEMPT`, or `confirmed` with `ends_at > now()` |
| list | bound id, version | the row's `id`, `version` |
| cancel dialog | testbed, start, Current note | the card's testbed name, start label, and phase |
| `cancelReservationAction` | guard | bound `bookingId`, `version`; session learner id; `users.status` under `FOR SHARE`; DB `now()` |
| `cancelReservationAction` | audit `phase` | `bookingPhase` of the locked row with `dbNow(trx)` |
| reschedule page | booking facts | `ownReschedulable` `ok`: id, version, type id, type name, duration, `starts_at`, `ends_at`, testbed name; `missing` gives `notFound()`, `unavailable` the card |
| reschedule page | email, timezone | session `users.email`, `users.timezone` |
| reschedule page | duration label | `formatDuration` of the type's current `duration_value`, `duration_unit` |
| `loadRescheduleStartsAction` | `starts`, `durationMs`, `now` | `startsFor(conn, typeId, { excludeBookingId })`; `now` is DB `now()` read once |
| Step 2 | the "Current" slot | the page's `starts_at` passed as `currentStart` |
| Step 2 | opening month | `currentStart`'s month when inside `monthRange`, else spec 0010 rule |
| Step 2 | picked day, picked start | both start null |
| Step 2, 3 | duration for highlight and Ends | the starts reply's `durationMs` (the page's label is display only) |
| `previewRescheduleAction` | testbed name, `endsAt` | `firstFreeTestbed(conn, typeId, startsAt, { excludeBookingId, preferTestbedId: booking.testbed_id })` |
| Step 3 | Current time | the page's `starts_at` in `users.timezone` |
| Step 3 | Timezone row | `zoneLabel(users.timezone, pickedStart)` |
| Step 3 | Current note | phase of the page's booking against the page's `now` (display only) |
| `rescheduleAction` | `version` | the page's `version` prop (the value the learner saw) |
| `rescheduleAction` | `endsAt` | `startsAt + durationMs(type)` read `FOR SHARE` in the transaction |
| `rescheduleAction` | `testbedTypeId` for `rescheduleBooking` | the locked booking's `testbed_type_id` |
| `rescheduleAction` | `slot_taken` vs `unavailable` when nothing is free | whether any candidate passed `lockBookableTestbed` (the saga's `anyLocked` rule) |
| `rescheduleAction` | idempotent retry | the learner's row with `starts_at` = requested start and `version` = expected + 1 |
| `rescheduleAction` | testbed | `preferFirst(bookableTestbedsOfType(type), booking.testbed_id)`, first with no overlapping live booking other than this one |
| `rescheduleAction` | audit from and to | the locked row's `starts_at`, `testbed_id`; the new `startsAt`, chosen testbed id |
| success | testbed, type, start, end | the `rescheduled` reply; formatted in the page's `timezone` |
| progress | which reply applies | the flow's submit id |
| buckets | key | session `users.id` |
| `/book` (signed in) | whether signed in | `currentSession()`: role `learner` and status `active` |
| `/book` (signed in) | account summary | session `users.name`, `company`, `email`, `timezone` |
| `checkDetailsAction`, `bookAction` (signed in) | name, company, email, timezone | the session's `users` row as stored, not parsed by `BookInput`; `company ?? ""` goes into `GuestBookingInput`, whose insert an existing row skips (`ON CONFLICT DO NOTHING`) |
| `checkDetailsAction`, `bookAction` (signed in) | email bucket key | the session's `users.email`, lowercased |
| `checkDetailsAction`, `bookAction` | `signed_out` | form `asAccount = "1"` and no active learner from `currentSession()` |

### Key invariants

- A learner can read or change only bookings whose `user_id` is their own `users.id`; an id that is not theirs behaves exactly like one that does not exist.
- Cancel and reschedule change one existing row; the booking id never changes, and no path inserts or deletes a booking.
- A reschedule either commits the new range or leaves the old one untouched: every refusal, deadlock, serialization failure, and overlap violation rolls back the one transaction.
- Both writes lock in one order: `users` row, booking, type, testbeds.
- `bookings_no_overlap` and `bookings_one_live_per_user` stay the last word: the read before the update only chooses a candidate.
- Past bookings never change (both guards need `ends_at > now()` at write time).
- Every decision uses DB `now()`; the browser clock is used only for display labels, progress timing, and list age.
- `reconcileAccess` stays the only code that adds or removes testbed group members.
- The version the action checks is the one the learner saw on the page.
- No learner data lives in the URL beyond the booking id, or in browser storage.

### Security model

- Roles: learner only. Every new page and action calls `requireLearner()` (admins are redirected as not authorized, deactivated users to the error page, anonymous callers to `/reservations`). None joins the public allow list.
- Ownership: every booking query filters by the session learner, so a guessed booking id returns `notFound()` on the page and `stale` or `gone` from the actions, with no data.
- Signed in `/book`: identity fields come from the session row, never the form, so a learner cannot book under another email by editing the post. A post that claims an account but has no session gets `signed_out`, never a guest booking. Turnstile stays on, because booking calls Authentik. The guest path is unchanged.
- Abuse: per user buckets on the reschedule reads and writes (AC-14). No Turnstile on reschedule, since a session is required and it makes no Authentik call. Cancel needs a live booking, so it cannot be churned.
- Deactivation: both writes lock the `users` row `FOR SHARE` with `status = 'active'`, so a learner deactivated mid action is refused and deactivation never misses a just changed booking.
- PII: the list and replies carry only the learner's own names and times. No PII in logs, URLs (beyond the booking id), or audit metadata (ids, times, phase, source only).
- Compliance: no regulated data beyond name and email, already in scope since spec 0003.

### Configuration required

None. No new env vars, credentials, or dependencies.

### Critical test scenarios

- List read (DB integration, rolled back): a learner with Current, Upcoming, Past, cancelled, and provisioning rows gets three cards in Current, Upcoming, Past order; another learner's rows never appear; soft deleted testbed and type names show; `reschedulable` is false for a deleted type and for a type with no bookable testbed; `hasLiveBooking` is true for a provisioning row under 1 minute old and false for an older one; `ownReschedulable` gives `missing` for another learner's id and `unavailable` for their own ended booking. Verifies **AC-1**, **AC-2**, **AC-6**, **AC-15**.
- Card helpers (unit): `sortCards` order and ties; `cardActions` for each phase and reschedulable flag; `firstName` trims and splits; `preferFirst` keeps the rest in order and ignores a missing preferred id. Verifies **AC-1**, **AC-9**.
- Cancel (DB integration): an Upcoming cancel sets `cancelled`, `cancel_source = 'learner'`, `cancelled_by_user_id` the learner, and writes one `booking.cancelled` row with the learner as actor; a Current cancel keeps `ends_at`; an Upcoming booking inside the 1 hour lead time cancels; a stale version, a Past booking, another learner's booking id, and a deactivated learner each return `stale` and change nothing. Verifies **AC-4**, **AC-5**, **AC-17**.
- Reschedule (DB integration, every time relative to `dbNow`): own testbed free at the new time keeps it; own testbed busy moves to the next free one in name order; the new range overlapping the booking's own old range on the same testbed succeeds; no free testbed gives `slot_taken` and leaves the row unchanged; inside the lead time gives `slot_taken`; the same start gives `same_time`; a deleted type gives `unavailable`; every testbed soft deleted gives `unavailable`, every testbed busy gives `slot_taken`; a stale version gives `stale`; a second call with the same start and the old version after a commit returns `rescheduled`; a booking whose own start is inside the lead time moves; a deactivated learner gets `stale`; a changed type duration sets `ends_at` from the new duration; `version` rises by one; one `booking.rescheduled` row with from and to. Verifies **AC-9**, **AC-17**.
- Reschedule race: a race cannot be staged on one connection inside `inRollback`, so test the two halves. (1) `rescheduleBooking` called straight into a range another live booking holds on that testbed throws the `bookings_no_overlap` violation, and `mapConstraintError` gives `overlap`. (2) The pure `toRescheduleError` turns `overlap`, `40P01`, and `40001` into `slot_taken` and rethrows anything else, and a `rescheduleOwnBooking` run that throws one leaves the original row unchanged. The manual two browser check goes in `verify.md`, as in spec 0004. Verifies **AC-9**.
- Starts and preview (DB integration): `startsFor` with `excludeBookingId` offers the booking's own range; without it, `/book` output is unchanged; `firstFreeTestbed` with `preferTestbedId` returns the preferred testbed when free and the name order one when not. Verifies **AC-7**, **AC-8**.
- Reducer (unit): every row of the reschedule transition table, including an older submit id being ignored and `?step=3` with no pick. Verifies **AC-10**, **AC-12**.
- Signed in `/book` (action tests): with a learner session, `bookAction` and `checkDetailsAction` use the session's email even when the form carries another one, and a learner with a null company books without a field error; `asAccount=1` with no session returns `signed_out` and books nothing; with an admin or deactivated session, or none, and no `asAccount`, they use the form as today. Verifies **AC-13**.
- Buckets: the 21st reschedule in an hour returns `limited`; the 61st starts load in 10 minutes returns `limited`. Verifies **AC-14**.
- Auth: the allow list test passes with none of the new actions on it; each new action called as admin or anonymous writes nothing. Verifies **AC-15**.
- Access (worker, DB integration with fake Authentik): after a learner cancels a Current booking, the next `reconcileAccess` removes the member and ends sessions; after rescheduling a Current booking to later, the same; audit rows `access.revoked` follow; the learner's `hol_auth.session` rows are untouched. Verifies **AC-16**.
- Journey (Playwright, the `learner` test account): sign in at `/reservations`; book through signed in `/book` (account summary, type only); see the Upcoming card; reschedule to another start and see the success screen and the moved card; cancel it and see the toast and "Reserve another lab". This also cleans up the test booking. Verifies **AC-1**, **AC-2**, **AC-4**, **AC-7**, **AC-8**, **AC-10**, **AC-11**, **AC-13**.
- Deactivated (Playwright, existing spec 0003 coverage extended): a deactivated learner who tries to sign in lands on the deactivated error page. Verifies **AC-3**.
- Axe, keyboard only cancel and reschedule, and screenshots at desktop and mobile widths for each AC-18 screen. Verifies **AC-18**.

## Build plan

Tracer Bullet: first a thin real thread (the signed in list reading real bookings), then thicken one strand at a time: cancel, a bare reschedule end to end, the reschedule polish, signed in `/book`, then the guards and end to end checks. No migration in any slice.

1. [x] List tracer: `server/booking/manage.ts` reads (`learnerBookings`, `hasLiveBooking`, the reschedulable rule), `lib/manage-reservations.ts` (`sortCards`, `cardActions`, `firstName`), and the `/reservations` list branch with cards, badges, the "Times in" note, the Reserve another link or note, and the empty state (buttons render but are inert). DB and unit tests. Satisfies **AC-1**, **AC-2**, **AC-3**, **AC-15**
2. [x] Cancel strand: `cancelOwnBooking` with its audit row, `cancelReservationAction`, the confirm dialog with the Current note, the toasts and revalidation, and the stale and ownership tests. Satisfies **AC-4**, **AC-5**, **AC-15**, **AC-17**
3. [x] Reschedule tracer: `excludeBookingId` and `preferTestbedId` in `availability.ts`, `preferFirst`, `rescheduleOwnBooking` (user and booking locks, the idempotent retry, type, offer check, candidates with the `anyLocked` rule, update, audit, `toRescheduleError`), `booking.rescheduled` in `AuditAction`, the reschedule page with `ownReschedulable` and the "can't be rescheduled" card, `loadRescheduleStartsAction` and `rescheduleAction`, and a minimal flow: Step 2 on `TimeStep`, Step 3 on `ConfirmStep` without preview, submit, and a plain success. DB tests for every AC-9 outcome. Satisfies **AC-6**, **AC-7**, **AC-9**, **AC-11**, **AC-15**, **AC-17**
4. [x] Reschedule thickening: `previewRescheduleAction`, the "Current" slot and opening month in `TimeStep`, the Current session note, `lib/reschedule-flow.ts` with `?step` history, submit ids, progress, the failure screen `flow` copy, every reply routed per the table, freshness, the three per user buckets, and the reducer tests. Satisfies **AC-7**, **AC-8**, **AC-10**, **AC-12**, **AC-14**
5. [x] Signed in `/book`: the page passes `account`, the Step 1 account summary, details seeded from the account, `asAccount` and the `signed_out` code, the session override in `checkDetailsAction` and `bookAction` (type and start parsed only, email bucket from the session), and the signed in success link and Done target, with action tests for the override, a null company, and `signed_out`. Satisfies **AC-13**
6. [x] Guards and end to end: the allow list test, the reconciler test for cancel and reschedule of a Current booking, the Playwright journey and deactivated check, axe, keyboard, and screenshots for each AC-18 screen, and the new pieces in `design.md`'s component table. Satisfies **AC-3**, **AC-13**, **AC-15**, **AC-16**, **AC-18**

## Consequences

**Positive**:
- The booking id survives a reschedule, so feature 15 can update one calendar event (`calendar_event_id`) and the "Manage my reservation" email button can deep link to a stable page.
- The overlap constraint, the version trigger, and the existing guarded helpers carry the atomicity; no new locking scheme.
- `/book`'s step components, timers, and freshness rules are reused, so both flows look and behave alike.
- A signed in learner books again in one choice, and cannot book under another email.

**Negative / tradeoffs**:
- Access lags a cancel or reschedule of a Current booking by up to two worker ticks (about a minute), and depends on the worker running. The testbed itself is free at once, and the dialog says "within a minute".
- Under a rare race, a reschedule can return `slot_taken` even though another testbed was free a moment later, because the overlap violation (or a deadlock) ends the whole transaction instead of trying the next candidate. The learner simply picks again.
- Signed in learners still solve Turnstile on `/book`, a small cost kept so booking has one guarded path.
- Rescheduling a Current booking ends the session they are in, with only a one line warning; the new start is at least an hour away.
- A changed type duration silently changes the length of a rescheduled booking (shown on Step 2 and Step 3, but not called out).
- The list has no pagination. A learner holds one live booking at a time, so the list grows by a few cards a month; revisit if any learner passes about 100.
- The manage pages show times only in the account zone; a learner who travels cannot change it yet. On signed in `/book` the zone is also fixed to the account's.
- No email or calendar update goes out on cancel or reschedule until feature 15.

**Neutral**:
- No migration, env, or dependency. One new audit action name.
- The mock's "View lab access" buttons wait for feature 14.
- Copy follows `design.md`'s allowed differences (no dashes), so the mock's one dashed sentence about finishing an active reservation becomes two sentences.

## Follow-up

- [ ] Feature 14: add "View lab access" to Current and Past cards and the `/reservations/[id]` detail page; the success screen here gains the lab access card.
- [ ] Feature 15: send the cancellation email (with the cancelled invite) from `cancelOwnBooking`, and the "Updated:" booking email with the moved invite from `rescheduleOwnBooking`; swap the third progress step for "Sending updated calendar invite" and add the mock's "An updated calendar invite was sent to <email>." line on success.
- [ ] Deferred (scope): let a learner change their account timezone from the manage page (spec 0008's admin edit already can).
- [ ] `app/reservations/actions.ts` `resendSetPassword` reads `cf-connecting-ip` directly instead of `clientIp()` from `server/request-ip.ts`, against the root `AGENTS.md` rule. `/develop` touches that file in task 2 and should switch it over (or route it to `/debug`).
- [ ] `/sync`: spec 0010's follow up (`excludeBookingId`, reuse of `time-step.tsx`, `confirm-step.tsx`, the progress screen) is fulfilled here; note `server/booking/manage.ts` in a context file if the booking area gets one.
