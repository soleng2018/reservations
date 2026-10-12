# 0010. Availability and booking rules

**Date**: 2026-10-11
**Status**: In Progress

## Summary

This spec turns the slice 1 `/book` page (one form with a plain list of times) into the mock's three step booking flow: your details, a month calendar with the day's half hour slots, then a confirm step that names the testbed you will get, followed by a progress screen and either a success or a failure screen. A booking still starts at least 1 hour away and on the half hour, but the window grows from 14 to 90 days ahead, and the server still picks the testbed and the end time. Two new read only public actions (checks with no writes) catch an email that already has a booking at Step 1 and preview the testbed at Step 3. There is no database change; the new pieces are a calendar (shadcn Calendar on react-day-picker), a searchable timezone picker, and pure timezone helpers built on `Intl`.

## Requirements

**User stories**:
- As a guest, I want to enter my details once, see only the days and times I can actually book in my own timezone, and confirm with the testbed named, so that booking feels quick and certain.
- As a guest who already has a booking, I want to be told at Step 1, not after picking a time, so that I go straight to managing it.
- As the owner, I want the last free slot to go to exactly one guest and every failure to land somewhere sensible, so that nobody is double booked or stranded.

**Acceptance criteria**:
- **AC-1**: `/book` opens Step 1 ("Step 1 of 3", "Tell us about you") as in the mock: Full name, Company name, Email address, Lab type, Your timezone, then Back (to `/`) and Continue. Lab type lists only types with at least one bookable testbed, labelled `<name> · <duration>` (`formatDuration`, e.g. "Basic · 4 hours"). Your timezone is a type to search combobox of every zone from `timezoneOptions`, the browser's zone preselected (UTC when it fails the `Timezone` check), each option labelled with the zone name (underscores as spaces) and its current offset, e.g. "America/New York (GMT-4)", with `UTC` shown as "UTC (GMT)". Options are sorted alphabetically and built in the browser after mount (no server render of the list). Typing filters by a case insensitive substring match on the visible label, so "york", "gmt-4", and "kolkata" all match. Field rules are spec 0004's (`BookInput`). With no bookable type, the card shows today's "No labs are open for booking right now. Please check back soon."
- **AC-2**: Continue calls `checkDetailsAction`, which runs in this order and writes nothing but rate limit rows: (1) the IP bucket `details:ip:<ip>` (20 per 600 s); (2) the Zod parse of the Step 1 fields (`DetailsInput`), returning field errors by path; (3) the email bucket `details:email:<lower email>` (10 per 3600 s), which fails open: over it, the action returns `ok` without reading anything, so nobody can lock a victim out of Step 1 and a probe learns nothing more (confirm still checks behind Turnstile); (4) read only checks, first match wins: the `users` row for `lower(email)` has role `admin` → `admin_email`; its status is not `active` → `refused`; it has a `confirmed` booking with `ends_at > now()` → `has_live_booking`; it has a `provisioning` booking created within the last minute → `booking_pending` (an older one is ignored, as the saga replaces it); the type is deleted or has no bookable testbed → `type_unavailable`. All clear → `ok`, and the guest moves to Step 2. An IP limit hit returns `limited`. No audit row is written at Step 1. Continue is disabled while the check runs, and every Continue runs the check again.
- **AC-3**: Step 1 shows each refusal inside its card. `has_live_booking`: the mock's panel, titled "You already have an active reservation", body "Sign in to manage it.", and a "Manage my reservations" button to `/reservations`; it never shows the learner's name or booking time. `booking_pending`, `admin_email`, `refused`, `limited`: their `BOOK_ERRORS` message in a destructive Alert. `type_unavailable`: the lab type list refreshes (`router.refresh()`), the removed type is deselected, and "That lab type is no longer available. Please pick another." shows under the Lab type field; every other input keeps its value. A thrown check or a network failure: "Something went wrong. Try again." in the Alert. Field errors show under their fields and focus moves to the first invalid one. Editing the email clears the panel.
- **AC-4**: Step 2 ("Step 2 of 3", "Choose a time", "<type> · <duration>") loads `loadStartsAction(typeId)`, which returns `{ starts, durationMs, now }` (ISO UTC starts, the type's duration, DB `now()`) or `{ limited: true }`. The month grid starts on Sunday. A day is enabled only when at least one free start falls on that calendar day in the chosen zone; every other day is greyed and cannot be picked. The grid opens on the month holding the first free start (the month of `now` in the zone when there is none), with no day picked and the prompt "Select a date to see available start times." Previous and next month are disabled outside the months from `now` to `now + 90 days` (`HORIZON_MS`) in the zone, so the guest can page through up to four months. Arrow keys move between days, Enter or Space picks one. A type with no free start shows "No free times in the next 90 days. Try another lab type." and Back.
- **AC-5**: Picking a day shows its panel: the day label ("Tuesday, October 13"), the hint "Pick a start time. Your full <duration> reservation will be highlighted below.", and every half hour start of that local day in the chosen zone (48 starts normally, 46 or 50 on a DST change day), grouped into rows by the local hour they start in. In a zone with a :45 offset a row reads, for example, 9:15 and 9:45. On the day clocks fall back, the repeated hour gets two rows, each labelled with the zone abbreviation ("1 AM EDT", "1 AM EST"). The starts are one native radio group (arrow keys move between free starts): free starts are enabled radios, taken or too soon ones greyed and disabled. Each radio's value is its ISO instant. Picking a day moves focus to the panel's day heading. Picking a start highlights every half hour of that day inside `[start, start + durationMs)` and shows the summary "<duration> reservation: <start> to <end>" (`formatDateTime` in the zone). Continue stays disabled until a start is picked. On mobile widths the calendar sits above the panel, and the panel appears once a day is picked.
- **AC-6**: The starts reload on entering Step 2, after a `slot_taken` result, and, on Step 2 only, when the tab becomes visible again with a list older than 5 minutes. No reload or preview fires while a submit is running (Server Actions run one at a time per client). If a reload drops the picked start, the pick clears and Step 2 shows "That time is no longer available. Please pick another." (this copy also replaces spec 0004's `slot_taken` message in `BOOK_ERRORS`). If the picked day has no free start left, its panel shows "No open times left on this day. Try another date." A `limited` reply, a thrown action, or a network failure shows "Please try again in a little while." with a Retry button, and keeps the current pick.
- **AC-7**: Step 3 ("Step 3 of 3", "Confirm your reservation") lists Name, Company, Email, Lab type, Timezone, then Starts, Ends, and Testbed assigned, with Back (to Step 2, keeping the pick) and "Confirm reservation". On entry it calls `previewTestbedAction(typeId, startsAt)`: the IP bucket `preview:ip:<ip>` (60 per 600 s), then a read with DB `now()` that returns `{ testbedName, endsAt }` for the first bookable testbed of the type in `lower(name)` order with no live booking overlapping `[start, start + duration)`, provided the start passes `isOfferableStart`. `taken` (no free testbed, the start now too soon, or bad input) sends the guest back to Step 2 with the AC-6 message and a reload. `limited`, a thrown action, or a network failure shows "Assigned when you confirm" as the testbed and the end from `durationMs`. The Timezone row shows the zone with its offset at the picked start (`zoneLabel(zone, start)`), since the offset can differ from today's. The Turnstile widget is mounted once in the flow container while the screen is Step 3, progress, or failure: visible on Step 3 and failure (an interactive challenge must be seen), kept mounted but visually hidden during progress, and unmounted on Back to Step 2 (a fresh widget renders on return). Confirm is disabled until the widget has a token, while a submit is running, and again when the token expires (`expired-callback` clears it). The preview holds nothing.
- **AC-8**: Confirm shows the progress screen (no history entry): a spinner, "Setting up your reservation", and a checklist "Reserving your testbed", "Setting up your account", "Confirming your reservation". The first two tick at 750 ms and 1500 ms; the last ticks only when `bookAction` returns `booked`. A `booked` reply ticks any unticked item at once, and the success screen follows 400 ms later. Any other reply routes at once (AC-9), whatever has ticked. There is no minimum display time. The screen is a polite live region; with reduced motion the spinner does not spin.
- **AC-9**: Every `bookAction` result lands by cause. `booked` → success (AC-10). `slot_taken` → Step 2 with the AC-6 message, a reload, and the pick cleared. `has_live_booking`, `booking_pending`, `admin_email` → Step 1 with the AC-3 display. `invalid` → Step 1 with field errors. `limited` (the IP or email bucket, or a failed Turnstile check, as spec 0004 AC-4) → Step 3 with "Please try again in a little while." `refused`, `unavailable`, `gone` → the failure screen: "Something went wrong", "We couldn't complete your reservation. Nothing was booked. Please try again." (the saga has already rolled back). A thrown action or a network failure → the same screen, but with "We couldn't confirm your reservation. If it went through, you'll find it under Manage an existing reservation." and a link to `/reservations`, because the booking may have committed before the reply was lost. Both have Back (to Step 3) and Try again. The widget resets after each reply; Try again is disabled until the fresh token arrives, then resubmits the same details. Each Try again counts against the 5 per 10 minute booking bucket, so a guest who keeps retrying lands on Step 3 with the limited message. A retry after a booking that did commit returns `has_live_booking` and shows the AC-3 panel.
- **AC-10**: The success screen follows the mock's card, rendered from the `bookAction` state and the in memory details, never from a URL: a check icon, "You're all set, <first name>!", the line "Your reservation is confirmed for <email>.", then Testbed, Lab type, Starts, Ends in the chosen zone. A new user sees the "Set your password" box ("Check your inbox for a link to set your password. You'll use it with your email to manage this reservation later."); a reused user sees "Sign in with your existing credentials anytime to manage this reservation." with a link to `/reservations`. A Done button goes to `/`. No lab links, Add to calendar, or View email (features 14 and 15).
- **AC-11**: Steps 2 and 3 push `?step=2` and `?step=3` to history, so browser Back and Forward move between steps with the details kept. Loading `/book?step=2` or `/book?step=3` with no details in memory (a refresh, a deep link, a new tab) replaces the URL with `/book` and shows an empty Step 1. The screen is derived from the URL step plus the flow phase: progress, failure, and success are phases that add no history entry and ignore browser Back and Forward (the guest leaves them with their own buttons). Each submit carries an id, and only the latest submit's reply is applied. After success the details are cleared and the URL is replaced with `/book`. Going back to Step 1 and changing the lab type or timezone clears the pick, the picked day, and the loaded starts.
- **AC-12**: Two guests confirming the same type for overlapping starts with one free testbed: exactly one is booked; the other lands on Step 2 with the AC-6 message (spec 0004 AC-10, now through this flow). With two free testbeds both succeed on different ones. The success screen always names the testbed actually assigned, even when it differs from the Step 3 preview.
- **AC-13**: `checkDetailsAction` and `previewTestbedAction` are on the allow list in `tests/server-actions-require.test.ts`. They return only a result code, field errors, ISO times, a testbed name, and an end time, never another learner's data. No page in the flow links to the admin URL, and `/book` stays `noindex`.
- **AC-14**: Each screen (Step 1, Step 2 with a day picked, Step 3, progress, failure, success) matches the mock at desktop and mobile widths within `design.md`'s allowed differences, built from its tokens and components. Axe reports no violations on each, a keyboard alone completes a booking, and screenshots of each are captured.

## Decision

**Chosen option**: Option 1: rebuild `/book` in place as one client flow on today's actions, plus two read only public actions.

`/book` stays one route whose client component steps through details, time, and confirm, keeping the step in the URL and the details in memory, and reusing `loadStartsAction` and `bookAction` with the saga unchanged.

**Implementation skills**: `shadcn` (`shadcn-ui/ui`, `.claude/skills/shadcn/`) · `shadcn-syntax-calendar-datepicker` and `shadcn-errors-react-day-picker-v9` (`impertio-studio/shadcn-ui-claude-skill-package`, `.claude/skills/shadcn-syntax-calendar-datepicker/`, `.claude/skills/shadcn-errors-react-day-picker-v9/`) · `base-ui` (`itechmeat/llm-code`, `.claude/skills/base-ui/`) · `shadcn-baseui` (`thunderboltdev/shadcn-baseui`, `.claude/skills/shadcn-baseui/`) · `vercel-react-best-practices` (`vercel-labs/agent-skills`, `.claude/skills/vercel-react-best-practices/`) · `kysely` (`mindrally/skills`, `.claude/skills/kysely/`) · `zod` (`pproenca/dot-skills`, `.claude/skills/zod/`) · `vitest` (`antfu/skills`, `.claude/skills/vitest/`) · `playwright-best-practices` (`currents-dev/playwright-best-practices-skill`, `.claude/skills/playwright-best-practices/`)

## Rationale

Reasoning and options: see [rationale.md](rationale.md).

## Feature design

### Data model sketch

No migration. Lead time and horizon stay code constants in `lib/slots.ts`: `LEAD_MS` stays 1 hour, and `HORIZON_MS` changes from 14 to 90 days (the engineer's call, 2026-10-11). Both the starts list and the saga's confirm recheck (`isOfferableStart`) read it, so the one constant moves both. The tables this feature touches, all from specs 0002 and 0004:

| Table | Used for | Access |
|---|---|---|
| `testbed_types` | type list with duration, starts, preview, end time | read |
| `testbeds` | bookable testbeds, preview name | read |
| `bookings` | busy ranges, Step 1 live booking check, preview overlap | read (writes only through the unchanged saga) |
| `users` | Step 1 check by `lower(email)` | read |
| `rate_limits` | new buckets `details:ip:<ip>`, `details:email:<lower email>`, `preview:ip:<ip>` | write through `countAttempt` |

No new audit actions.

### State transitions

**booking.status**: unchanged (spec 0004).

**The client flow** (`components/book/booking-flow.tsx`, one `useReducer`):

The screen is derived from two things: the URL step (`details`, `time`, `confirm`) and a phase (`editing`, `progress`, `failure`, `success`). Browser Back and Forward change only the URL step, and only while the phase is `editing`; a `popstate` in any other phase is ignored and the URL is restored with `replaceState`.

| From | Event | To |
|---|---|---|
| `details` | Continue, check `ok` | `time` (push `?step=2`) |
| `details` | check `invalid` | `details` with field errors |
| `details` | check refused (`admin_email`, `refused`, `has_live_booking`, `booking_pending`, `type_unavailable`) | `details` with the AC-3 display |
| `details` | check `limited`, thrown, or network failure | `details` with the Alert, no field errors |
| `details` | lab type or timezone changed | `details` (pick, picked day, and starts cleared) |
| `time` | starts `limited`, thrown, or network failure | `time` with Retry, pick kept |
| `time` | Continue with a pick | `confirm` (push `?step=3`) |
| `time` | Back or browser Back | `details` |
| `confirm` | preview `taken` | `time` with the AC-6 message and a reload |
| `confirm` | preview `limited`, thrown, or network failure | `confirm` with "Assigned when you confirm" |
| `confirm` | token expired | `confirm` with Confirm disabled |
| `confirm` | Confirm (token ready) | phase `progress`, new submit id |
| `confirm` | Back or browser Back | `time` (widget unmounts) |
| `progress` | reply for an older submit id | ignored |
| `progress` | `booked` | phase `success` (replace URL with `/book`, clear details) |
| `progress` | `slot_taken` | `time` with the AC-6 message and a reload |
| `progress` | `has_live_booking`, `booking_pending`, `admin_email` | `details` with the AC-3 display |
| `progress` | `invalid` | `details` with field errors |
| `progress` | `limited` | `confirm` with the message |
| `progress` | `refused`, `unavailable`, `gone` | phase `failure` ("Nothing was booked") |
| `progress` | thrown or network failure | phase `failure` ("If it went through...") |
| `failure` | Back | `confirm`, phase `editing` |
| `failure` | Try again (token ready) | phase `progress`, new submit id |
| `success` | Done | navigate to `/` |
| `time` or `confirm` | loaded with no details in memory | `details` (replace URL with `/book`) |

### API surface

| Surface | Kind | Key inputs | Key outputs | Auth | Key errors |
|---|---|---|---|---|---|
| `/book` page | Server Component | `searchParams.step` (read by the client only) | bookable types `{ value, label }` with the duration in the label, Turnstile site key | public, `noindex` | none |
| `checkDetailsAction` (`app/book/actions.ts`) | Server Action | `name`, `company`, `email`, `timezone`, `testbedTypeId` (strings) | `{ kind: 'ok' } \| { kind: 'error', code: DetailsErrorCode, fields }` | public (allow list); 20 per IP per 10 min, 10 per email per hour | `invalid`, `limited`, `admin_email`, `refused`, `has_live_booking`, `booking_pending`, `type_unavailable` |
| `loadStartsAction` (changed) | Server Action | `testbedTypeId`: uuid | `{ starts: readonly string[]; durationMs: number; now: string } \| { limited: true }` | public (allow list); 60 per IP per 10 min | unknown or unbookable type gives `starts: []`, `durationMs: 0` |
| `previewTestbedAction` (`app/book/actions.ts`) | Server Action | `testbedTypeId`: uuid, `startsAt`: ISO string | `{ kind: 'ok', testbedName, endsAt } \| { kind: 'taken' } \| { kind: 'limited' }` | public (allow list); 60 per IP per 10 min | bad input reads as `taken` |
| `bookAction` | Server Action, unchanged | as spec 0004; the client calls it directly as `bookAction({ kind: 'idle' }, formData)` (not through `useActionState`), building the FormData from flow state plus `cf-turnstile-response` from the widget callback | `BookState` as spec 0004 | public (allow list) | as spec 0004 |

Modules:

| Module / function | Signature | Notes |
|---|---|---|
| `lib/booking-input.ts` `DetailsInput` | `BookInput.pick({ name, company, email, timezone, testbedTypeId })` | `BOOK_ERRORS` gains `type_unavailable`, and `slot_taken` becomes "That time is no longer available. Please pick another."; `DetailsErrorCode` is the AC-2 code union. The `fields` of an error reply are empty except for `invalid`. |
| `lib/calendar-days.ts` | `dayKey(d, tz)` (moved from `format-time.ts` and exported; today it is a private const), `freeDayKeys(starts, tz): ReadonlySet<string>`, `halfHoursOfDay(key, tz): readonly Date[]`, `hourRows(starts, tz)` (rows by local start hour, the repeated fall back hour split by zone abbreviation), `monthRange(now, horizonMs, tz): { first: string; last: string }` (yyyy-mm), `keyToLocalDate(key): Date` and `localDateToKey(d): string` | Pure, `Intl` only. `halfHoursOfDay` walks the UTC half hour grid from `key` minus 14 h to plus 38 h and keeps the starts whose `dayKey` equals `key`, so DST and odd offsets fall out. The calendar gets "floating" dates at browser local **noon** of each key (never midnight, which some zones skip at DST), never a `timeZone` prop. `groupByDay` goes once `book-form.tsx` is removed, if nothing else uses it. |
| `lib/timezones.ts` `zoneLabel` | `(zone: string, at: Date) => string` | "America/New York (GMT-4)" via `timeZoneName: 'shortOffset'`, "UTC (GMT)" for `UTC`; display only. |
| `server/booking/availability.ts` | `bookableTypes` adds `durationValue`, `durationUnit`; `startsFor` returns `{ starts, durationMs, now }` (the one `dbNow` read feeds both `freeStarts` and the reply); new `firstFreeTestbed(conn, typeId, startsAt): Promise<{ testbedName, endsAt } \| null>` | `startsFor`'s only callers are `loadStartsAction` and `availability.test.ts`. `firstFreeTestbed` reads the type, `dbNow`, `isOfferableStart`, `bookableTestbedsOfType`, and live bookings overlapping the range; same order as the saga, no locks. |
| `server/booking/details-check.ts` `checkGuestDetails` | `(conn, { email, testbedTypeId }) => Promise<Result<void, Exclude<DetailsErrorCode, 'invalid' \| 'limited'>>>` | The AC-2 step (4) reads. Shares `STALE_OWN_ATTEMPT` (the `sql` fragment in `server/db/guest-saga.ts`, now exported) so its one minute matches the saga. |
| `components/turnstile.tsx` `Turnstile` | `({ siteKey, onToken?, resetSignal? })` | Explicit render (`api.js?render=explicit`, `turnstile.render` with `callback`, `expired-callback`, `error-callback`). Keeps its widget id per instance and resets (`turnstile.reset(id)`) when `resetSignal` changes and removes (`turnstile.remove(id)`) on unmount. Renders from the script's `onLoad`, or at once when `window.turnstile` already exists (client navigation), guarding against a second render under StrictMode. It still writes the hidden `cf-turnstile-response` input, so the resend form on `/reservations` keeps working; that form moves from the global `resetTurnstile()` to `resetSignal`, and `resetTurnstile` is removed. One script mode app wide. |
| `components/ui/calendar.tsx`, `components/ui/combobox.tsx` | `npx shadcn add calendar combobox` (style `base-nova`) | Restyled to `design.md` tokens. |
| `components/book/booking-flow.tsx` | the client reducer and URL sync | Replaces `book-form.tsx`. |
| `components/book/details-step.tsx`, `time-step.tsx`, `confirm-step.tsx`, `progress-screen.tsx`, `failure-screen.tsx`, `booking-success.tsx` | one per screen | `time-step.tsx` takes plain props (`starts`, `durationMs`, `now`, `timezone`, `picked`, `onPick`) and `confirm-step.tsx` takes a summary object, so feature 13 reuses both for reschedule. `booking-success.tsx` replaces `booking-confirmation.tsx`. |
| `components/timezone-combobox.tsx` | `({ name, value, onValueChange, options })` | Base UI combobox that submits under `name`; works inside `Field`. |

### Value sourcing

| Action | Value | Source |
|---|---|---|
| `/book` | lab type label | `testbed_types.name` plus `formatDuration(duration_value, duration_unit)` from `bookableTypes` |
| `/book` | default timezone | `browserTimeZone()` (spec 0004) |
| `/book` | timezone option labels | `zoneLabel(zone, new Date())` in the browser; display only, not a booking decision |
| `checkDetailsAction` | client IP | `clientIp(headers)` (spec 0004) |
| `checkDetailsAction` | fail open over the email bucket | the `countAttempt` result for `details:email:<lower email>`: `false` returns `ok` with no reads |
| `checkDetailsAction` | admin, deactivated | `users.role`, `users.status` for `lower(email)` |
| `checkDetailsAction` | live booking | `bookings.status = 'confirmed'` and `ends_at > now()` for that user |
| `checkDetailsAction` | pending attempt | `bookings.status = 'provisioning'` and `created_at >= now() - interval '1 minute'` |
| `checkDetailsAction` | type bookable | `testbed_types.deleted_at is null` and `bookableTestbedsOfType` not empty |
| `loadStartsAction` | `now` | DB `now()` read once per call |
| `loadStartsAction` | `durationMs` | `durationMs(duration_value, duration_unit)` of the type |
| `loadStartsAction` | `starts` | `freeStarts` as spec 0004, `LEAD_MS`, `HORIZON_MS` |
| Step 2 | enabled days | `freeDayKeys(starts, timezone)` |
| Step 2 | opening month, month limits | first free start's key, else `now`; `monthRange(now, HORIZON_MS, timezone)` |
| Step 2 | the calendar's "today" | `keyToLocalDate(dayKey(now, timezone))` passed as `today`, so no browser clock is used |
| Step 2 | a day's slots | `halfHoursOfDay(key, timezone)`, each free when its ISO is in `starts` |
| Step 2 | highlight and summary end | picked start plus `durationMs` |
| Step 2 | list age for the refocus reload | the browser time when the list arrived (display freshness only) |
| `previewTestbedAction` | testbed name, `endsAt` | `firstFreeTestbed`: `testbeds.name`; `startsAt + durationMs(type)` with DB `now()` for the offer check |
| Step 2 | hour rows and their labels | `hourRows(halfHoursOfDay(key, tz), tz)`: `formatTime` hour in the zone, plus the zone abbreviation on a repeated hour |
| Step 3 | Name, Company, Email, Lab type | the Step 1 details in memory; lab type label from the page props |
| Step 3 | Timezone row | `zoneLabel(timezone, pickedStart)` |
| progress | which reply applies | the submit id the flow increments on each Confirm or Try again |
| Step 3 | Starts | the picked start |
| Step 3 | Ends | preview `endsAt`, else picked start plus `durationMs` |
| `bookAction` | `cf-turnstile-response` | the widget's `callback` token held in flow state |
| `bookAction` | everything else | as spec 0004 (testbed and end decided in saga step 1) |
| success | first name | the first word of the trimmed Step 1 name |
| success | email | the Step 1 email |
| success | testbed, type, start, end, `newUser` | the `booked` state from `bookAction` |
| progress | tick timing | client timers (750 ms, 1500 ms, plus 400 ms after `booked`) |
| `/book?step=` | current step | the URL, honored only when the details exist in memory |

### Key invariants

- The client never picks the testbed or the end time; the preview is advice, and saga step 1 decides (spec 0004).
- No new path writes `bookings` or `users`. `checkDetailsAction` and `previewTestbedAction` write only `rate_limits`.
- Every booking decision uses DB `now()`: starts, the offer check, the preview, and the Step 1 live booking check. The browser clock is used only for display labels, progress timing, and list age.
- A day is enabled only if a free start from the server falls on it in the chosen zone, so past days and days beyond the horizon are never selectable.
- The Step 1 refusal panel never shows the learner's name or booking time.
- One Turnstile script mode (explicit) app wide; a token is never reused (the widget resets after every reply).
- Details live in React state only, never in the URL, storage, or a cookie.
- While a submit runs, no other `/book` action is called, and only the latest submit's reply is applied.
- Progress, failure, and success never change because of browser Back or Forward.

### Security model

- All four `/book` actions are public, so each is guarded by its own IP bucket; `checkDetailsAction` also by an email bucket (counted only after the parse); `bookAction` keeps Turnstile plus its two buckets (spec 0004 AC-4).
- `checkDetailsAction` confirms to anyone that an email has a booking, is an admin's, or is deactivated. This is the same exposure spec 0004 AC-8 already accepted at confirm, now one step earlier and without Turnstile, bounded by 20 per IP per 10 min and 10 answered checks per email per hour. Past the email bucket it fails open (answers `ok`, reads nothing), so the bucket cannot be used to lock a real guest out of Step 1.
- `previewTestbedAction` tells anonymous callers which testbed name of a type is free at a time. At 60 per IP per 10 min someone could map which named testbed is busy when; accepted, since testbed names are not secret (they appear on the success screen and in emails) and the starts list already shows overall availability.
- PII stays in the browser tab's memory and in the `bookAction` request, as today. No PII in logs, audit metadata, or URLs.

### Configuration required

- No new env vars or credentials.
- New dependency: `react-day-picker` v9 (through `npx shadcn add calendar`).

### Critical test scenarios

- Calendar helpers (unit): `halfHoursOfDay` gives 48 starts on a normal day, 46 on 2026-03-08 and 50 on 2026-11-01 in `America/New_York`, starts at :15 and :45 in `Asia/Kathmandu`, :00 and :30 in `Asia/Kolkata`, and 48 starts on a half hour DST change day in `Australia/Lord_Howe`; `hourRows` splits the repeated 1 AM on 2026-11-01 into "1 AM EDT" and "1 AM EST"; `freeDayKeys` puts a start at 23:30 UTC on the next day in `Asia/Tokyo`; `keyToLocalDate` returns local noon; `monthRange` with the 90 day horizon spans four months when `now` is late in a month and three when it is on the 1st. Verifies **AC-4**, **AC-5**.
- Horizon (unit): `freeStarts` with `HORIZON_MS` lists a start exactly 90 days out and none after; `isOfferableStart` refuses 90 days plus 30 minutes. Verifies **AC-4**.
- Starts shape (DB integration, rolled back): `startsFor` returns `durationMs` and DB `now`; an unknown type returns empty. Verifies **AC-4**.
- Step 1 check (DB integration, rolled back): each refusal in AC-2 order (admin, deactivated, confirmed live, provisioning under 1 minute, deleted type, type with no bookable testbed); a provisioning row over 1 minute old and a confirmed booking that has ended pass; nothing but `rate_limits` changes. Verifies **AC-2**.
- Step 1 limits: the 21st check from one IP in 10 minutes returns `limited`; the 11th per email per hour returns `ok` for an email that has a live booking (fail open, no reads); a bad parse returns field errors before the email bucket counts. Verifies **AC-2**, **AC-3**.
- Preview (DB integration, rolled back): two testbeds, the first busy, gives the second's name; all busy gives `taken`; a start inside the lead time gives `taken`; `endsAt` follows the type duration. Verifies **AC-7**.
- Flow reducer (unit): every row of the transition table, including each `bookAction` code, a reply for an older submit id being ignored, a `popstate` during progress being ignored, the "no details in memory" fallback, and a type or timezone change clearing the pick. Verifies **AC-6**, **AC-8**, **AC-9**, **AC-11**.
- Success copy (component test): `newUser: true` shows the Set your password box, `false` shows the sign in line and link; the heading uses the first word of the name. Verifies **AC-10**.
- Happy path (Playwright): Step 1 to success with a `dev-` email; the calendar greys a day with no free start; picking a start highlights its duration; Step 3 names a testbed; success shows the same testbed and "You're all set". Verifies **AC-1**, **AC-4**, **AC-5**, **AC-7**, **AC-8**, **AC-10**.
- Active booking (Playwright): a second run with the same email is stopped at Step 1 with the panel and its link, and no name or time on it. Verifies **AC-3**.
- Slot taken (Playwright, two browser contexts on a type with one testbed): both reach Step 3 for the same start, both confirm; one succeeds, the other lands on Step 2 with the message and the time gone. Verifies **AC-6**, **AC-9**, **AC-12**.
- Failure screen (Playwright with route interception of the action, or fake Authentik in a component test): `unavailable` shows "Nothing was booked", a dropped response shows the "If it went through" copy with its link, and Try again waits for a fresh token and resubmits. Verifies **AC-9**.
- History (Playwright): Back from Step 3 returns to Step 2 with the pick; reloading `/book?step=3` lands on an empty Step 1. Verifies **AC-11**.
- Allow list and leak: the allow list test passes; the preview and check replies contain no email, name, or booking id. Verifies **AC-13**.
- Axe, keyboard only booking, and screenshots at desktop and mobile widths for each screen. Verifies **AC-14**.
- Turnstile (Playwright with the always pass test keys): the resend set password form on `/reservations` still submits a valid token after the explicit render switch, including after a client navigation from `/book`; on `/book`, Confirm is disabled until the callback fires. Verifies **AC-7**, **AC-9**.

## Build plan

Tracer Bullet: first a thin thread through all three steps on today's actions (real calendar, real submit, plain screens), then thicken each strand: the Step 1 check, the preview and failure paths, the success card, freshness, then the end to end guards.

1. [x] Pure helpers: `lib/calendar-days.ts` (moving and exporting `dayKey` from `format-time.ts`, `hourRows`, noon floating dates) and `zoneLabel`, with the DST, offset, and Lord Howe unit tests. Satisfies **AC-1**, **AC-4**, **AC-5**
2. [x] Tracer: `HORIZON_MS` becomes 90 days; `npx shadcn add calendar`; `startsFor` and `loadStartsAction` return `{ starts, durationMs, now }`; `bookableTypes` adds the duration and the page labels types; `booking-flow.tsx` reducer with `?step` sync; Step 1 (today's fields), Step 2 (calendar plus day panel), Step 3 (summary without preview), submitting through `bookAction` to today's confirmation. Remove `book-form.tsx`. Satisfies **AC-1**, **AC-4**, **AC-5**, **AC-11**
3. [x] Step 1 check: `DetailsInput`, `server/booking/details-check.ts`, `checkDetailsAction` with its buckets, the AC-3 panel and alerts, the type list refresh, the allow list entry, and rolled back tests. Satisfies **AC-2**, **AC-3**, **AC-13**
4. [x] Timezone combobox: `npx shadcn add combobox`, `components/timezone-combobox.tsx` with offset labels and filtering. Satisfies **AC-1**
5. [x] Step 3 preview and Turnstile: `firstFreeTestbed`, `previewTestbedAction` with its bucket and allow list entry, the `taken`, `limited`, and thrown paths, the offset at the picked start, and the explicit render `Turnstile` with per instance ids, `resetSignal`, token expiry, and the resend form moved off `resetTurnstile()` (checking it still works after a client navigation). Satisfies **AC-7**, **AC-12**, **AC-13**
6. [x] Progress, failure, and routing: the phase model (URL step plus phase, `popstate` ignored outside editing, submit ids), the progress screen and timers, every `bookAction` code routed per the table, both failure copies, Try again on a fresh token, and the reducer unit tests. Satisfies **AC-8**, **AC-9**, **AC-11**
7. [x] Success card: `booking-success.tsx` to the mock (heading, line, rows, new or reused user box, Done). Satisfies **AC-10**
8. [x] Freshness: the refocus reload when over 5 minutes old, the dropped pick message, the empty day message, and the limited Retry. Satisfies **AC-6**
9. [x] Guards and end to end: update `e2e/booking.spec.ts` for the three steps, add the active booking, two context slot taken, history, and failure specs, extend `e2e/a11y.spec.ts` and `e2e/screenshots.spec.ts` for each screen at both widths, and add the new pieces to `design.md`'s component table. Satisfies **AC-3**, **AC-9**, **AC-11**, **AC-12**, **AC-13**, **AC-14**

## Consequences

**Positive**:
- The guest sees only bookable days and times, in their zone, before typing anything twice; a known email is stopped before it picks a time.
- The saga, the constraints, and `bookAction` are untouched, so the race safety and rollback proven in spec 0004 carry over as is.
- The time picker and confirm summary are flow agnostic, so feature 13's reschedule reuses them.

**Negative / tradeoffs**:
- `checkDetailsAction` exposes, without Turnstile, whether an email has a booking, is an admin's, or is deactivated (accepted, bounded by the two buckets). Past the email bucket it fails open, so a heavily probed email gets no early warning at Step 1 and is caught at confirm instead.
- The Step 3 testbed is a preview; under a race the success screen can name a different testbed. The preview also lets anyone map which named testbed is busy when.
- A lost reply after a committed booking shows a hedged failure message; the guest finds the booking under Manage, or gets the active booking panel on retry.
- The progress checklist is paced by timers, not by the saga's real steps.
- A new dependency (`react-day-picker`, with `date-fns` under it) and two new public actions, each with its own rate bucket.
- Each starts load sends the whole 90 day window: up to about 4,320 ISO strings, roughly 115 KB before compression (gzip shrinks the repeated ISO text heavily, to well under 20 KB). Refocus reloads resend it and spend the 60 per 10 minute starts budget faster. If this ever measures slow, send epoch minutes instead of ISO strings, or load one month at a time.
- With one active booking per learner, a learner who books far out cannot book an earlier lab until that booking is rescheduled (feature 13) or cancelled. Bookings made weeks ahead are also more likely to become no shows, holding a testbed nobody uses.
- A refresh on Step 2 or 3 loses the details by design (no PII in browser storage).
- In dev, with `TRUST_PROXY_HEADERS` off, every caller shares the IP buckets, so the 20 per 10 minute Step 1 bucket runs out quickly during manual testing.
- Turnstile moves to explicit rendering for every caller, including the resend form.

**Neutral**:
- No migration and no new env. The rollout replaces the `/book` form at once; reverting the commit restores the slice 1 form.
- Copy follows `design.md`'s allowed differences (no dashes); the success line about email changes in feature 15.

## Follow-up

- [ ] Feature 13: add an optional `excludeBookingId` to `startsFor` and `firstFreeTestbed`, reuse `time-step.tsx`, `confirm-step.tsx`, and the progress screen with the mock's reschedule labels ("Updating your reservation", "Reassigning your testbed").
- [ ] Feature 14: add the lab access card to `booking-success.tsx`, gated on `email_verified_at` (spec 0003 AC-7).
- [ ] Feature 15: add "Sending calendar invite & email" to the progress checklist, change the success line to the mock's "A confirmation email and calendar invite were sent to <email>.", and add Add to calendar and View email.
- [ ] `/sync`: add `shadcn-syntax-calendar-datepicker`, `shadcn-errors-react-day-picker-v9`, `base-ui`, and `shadcn-baseui` to root `AGENTS.md` `## Agent skills`; record `morksen123/base-ui-mcp-server` under `Declined:`; note that Turnstile renders explicitly app wide.
- [ ] `/sync`: spec 0004's `loadStartsAction` row, its "Show more days" list, its AC-3 "within 14 days" rule (now 90), and its AC-7 copy ("That time was just taken") are replaced by this spec.
- [ ] `/develop`: confirm the react-day-picker v9 prop names on the installed version (`mode="single"`, `startMonth`, `endMonth`, `today`, `disabled`, `weekStartsOn`) against the `shadcn-errors-react-day-picker-v9` skill before styling.
