# 0010. Availability and booking rules: rationale

## Context

Slice 1 (spec 0004) proved booking end to end with a deliberately thin `/book`: one form, a lab type select, and a list of free start chips grouped by day, seven days at a time. Feature 12 must match the mock (`context/reservations_mock.html`): Step 1 details, Step 2 a month calendar with unavailable days greyed and the day's half hour grid with the reservation highlighted, Step 3 a confirm summary naming the assigned testbed, then progress, failure, and success screens. The scope's done line adds two rules the slice 1 page does not meet: only bookable days and times in the learner's zone, and an email with an active booking stopped at Step 1.

Forces:
- **The server owns the booking decision.** The saga assigns the testbed under locks and derives the end time (spec 0004 AC-5); the DB is the clock (spec 0001). Anything the client shows before confirm is advisory.
- **The mock's Step 1 check reads private data.** Telling an anonymous caller that an email has a booking is a disclosure; the mock even shows the learner's name and booking time.
- **Timezones are the hard part.** A "day" is a calendar day in the chosen IANA zone; DST days have 46 or 50 half hours, and :45 offset zones put the UTC half hour grid at :15 and :45. Node 24 and Safari lack `Temporal`.
- **Three steps on a single page app break the browser Back button** unless the step lives in history, and putting PII in storage or URLs to survive a refresh has its own cost.
- **Turnstile tokens are single use**, and a retry from a failure screen needs a fresh one.
- **Feature 13 reuses the calendar for reschedule** but has no design step of its own.

## Options considered

### Option 1: Rebuild `/book` in place as one client flow (chosen)

One route; a client reducer steps through details, time, confirm, progress, failure, and success, pushing `?step=` to history and keeping details in memory. Reuses `loadStartsAction` (extended) and `bookAction`; adds two read only public actions (Step 1 check, Step 3 preview).

**Pros**: no saga or schema change; spec 0004's race and rollback proofs carry over; one place for flow state; Back works.
**Cons**: a refresh on Step 2 or 3 loses the details; two more public actions to guard.

### Option 2: A route per step

`/book`, `/book/time`, `/book/confirm`, with details carried in `sessionStorage` or a signed cookie, each step server rendered.

**Pros**: refresh safe; each step independently linkable.
**Cons**: PII in browser storage or a cookie; three pages to keep consistent; deep links into later steps need guards; more code for the same screens.

### Option 3: A server held draft with a testbed hold

Create a draft (and a short testbed hold) at Step 1 or Step 3, then confirm it. Step 3 would show a guaranteed testbed.

**Pros**: the Step 3 testbed is certain; a refresh can resume.
**Cons**: needs a holds table or a userless booking, a migration, a sweeper, and new races between holds and the saga; anonymous callers could hold capacity, which is a denial of service lever.

## Rationale

Option 1 keeps the one hard part already solved (assignment under locks) untouched and puts all new work in the UI and two reads. The disclosure and the race are handled by being honest rather than by new state: the Step 1 check returns a generic panel (no name or time) behind its own IP and email buckets, accepting the same exposure spec 0004 AC-8 already accepted at confirm; the Step 3 testbed is a preview using the saga's own order, and the success screen always shows the real assignment. Option 3's certainty is not worth a migration and a capacity holding lever for anonymous users. Option 2's refresh safety costs PII in storage; the engineer chose memory only with the step in the URL.

Smaller calls, each the engineer's pick unless marked as mine:
- **Lead time stays 1 hour; the horizon grows from 14 to 90 days; both stay code constants.** The engineer first kept 14 days, then moved it to 90 days on 2026-10-11 so learners can plan a quarter ahead. The cost is a larger starts payload (still small once compressed), up to four calendar months to page through, and more room for no shows; see Consequences. Env vars would let the web and worker processes disagree on one shared database; per type columns are a migration for a need nobody has.
- **Full day slot grid, taken greyed**, as in the mock, so the duration highlight reads naturally.
- **shadcn Calendar (react-day-picker v9)** over a hand built grid: the WAI-ARIA date grid keyboard model comes tested. Runner up: hand built, which owns the same a11y code ourselves.
- **Intl only helpers, with floating dates for the calendar** (mine on the floating dates). Walking the UTC half hour grid and filtering by `dayKey` handles DST and odd offsets with no library; passing react-day-picker plain local midnights per key avoids its `timeZone` prop and a second date model. Runner up: `@date-fns/tz`, a direct dependency for what three small functions do.
- **Base UI Combobox** for the timezone, matching the Base UI primitives `FormSelect` already uses.
- **Honest timed checklist** with today's real steps; the email step joins in feature 15.
- **Explicit Turnstile rendering app wide** (mine). Retry in place needs a token callback; the script's mode is global per page load, and client navigation keeps the script, so `/book` and the resend form must share one mode. Explicit render still writes the hidden input the resend form reads. Runner up: a `data-callback` global function with implicit render, which leaks a global and is harder to reset per mount.
- **Step 1 check skips the audit write** so anonymous probing cannot grow `audit_events`; confirm still audits admin emails.
- **The per email Step 1 bucket fails open** (mine, from the cross check). A closed bucket would let anyone lock a real guest out of Step 1 for an hour by spending it; open, the over limit probe gets `ok` and learns nothing, and confirm still checks behind Turnstile. Runner up: key the bucket by IP and email together, which stops the lockout but no longer caps probing of one email from many IPs.
- **Screens come from the URL step plus a phase, with submit ids** (mine, from the cross check). Progress, failure, and success ignore browser Back and Forward, and a stale reply never overwrites a newer one; otherwise Back during a slow Authentik call would leave a result with nowhere to land.
- **A lost reply gets a hedged failure message** (mine, from the cross check). The booking may have committed before the network dropped, so "Nothing was booked" is said only where the saga has already rolled back.
- **`type_unavailable` at Step 1** (mine): a type that lost its testbeds since the page loaded gets its own message and a list refresh, instead of a confusing empty calendar.
- **Focus moves to each screen's heading on step change** (mine), so screen reader and keyboard users land at the top of the new step.
- **Step 1 refusals show inside the Step 1 card as an Alert** (mine), the same rule `design.md` gives for failures inside an open form.

### Mock copy replaced

| Mock | This spec | Why |
|---|---|---|
| "Priya, you have an upcoming reservation on Oct 13 · 9:00 AM ET. Finish or reschedule it before booking another." | "You already have an active reservation" / "Sign in to manage it." | No name or schedule to anonymous callers |
| Progress: "Creating your account", "Reserving your testbed", "Sending calendar invite & email" | "Reserving your testbed", "Setting up your account", "Confirming your reservation" | The saga's real order; no email until feature 15 |
| "A confirmation email and calendar invite were sent to <email>." | "Your reservation is confirmed for <email>." | No email until feature 15 |
| "We couldn't complete your reservation. Nothing was booked — please try again." | "... Nothing was booked. Please try again." (known rollbacks); "We couldn't confirm your reservation. If it went through, you'll find it under Manage an existing reservation." (lost reply) | No dashes (`design.md`); a lost reply may hide a committed booking |
| Spec 0004: "That time was just taken. Please pick another." | "That time is no longer available. Please pick another." | Also covers a start that slipped inside the lead time |
| "Tap a start time — your full ... will be highlighted below." | "Pick a start time. Your full ... will be highlighted below." | No dashes; works with a mouse too |
| Ten fixed zones with abbreviations | Every IANA zone with its live offset | Learners outside those ten zones |
