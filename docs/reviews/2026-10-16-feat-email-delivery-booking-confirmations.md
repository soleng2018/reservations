# Review, feat/email-delivery-booking-confirmations, 2026-10-16

**Reviewed by**: Sonnet 5.5 (author on a different model run)
**Scope**: 178 files, branch vs main (committed work plus the uncommitted docs and test edits)
**Verdict**: Changes requested

## Summary
The branch carries three features. Spec 0011 (manage reservations) was reviewed on 2026-10-13 with no blockers or majors, and its two minors were answered in that file, so it was not re-reviewed in depth. Spec 0012 (lab access screens) is clean. Spec 0013 (email delivery, calendar mirror, Google service account and Google sign in) is well built: the outbox, the claim query, the lock first send, the sign in cookie and the secret handling all follow the spec and the project rules. One real defect stops a merge: the MIME layout makes iOS Mail show no email body, which is the main thing a learner should receive. The rest are small.

## Major
### 🟠 iOS Mail shows only two .ics files and no body, `server/email/compose.ts:140`
**Problem**: `icalEvent` makes nodemailer build `multipart/alternative` in this order: text, html (inside `multipart/related` with the logo), then `text/calendar` last (`node_modules/nodemailer/dist/esm/mail-composer/index.js` around lines 297 to 303, where `text`, `html`, then `eventObject` are concatenated). RFC 2046 says the last alternative is the preferred one, so iOS Mail picks the calendar part and shows it as `mime-attachment.ics` next to `invite.ics`. I confirmed the ordering in the library source and the `compose.test.ts` snapshot only checks that `multipart/alternative` exists. I could not run an iPhone here, so the exact cause on iOS (the order, or the nested `multipart/related`) should be proven by a retest after the fix. Gmail web is fine and Outlook is untested.
**Why it matters**: The lab links live only in the HTML body. A learner on an iPhone gets a booking email with no visible links, access times or buttons. The calendar invite description carries only the manage link, so there is no fallback inside the email. Learners can still open `/reservations`, which is why this is Major and not a Blocker.
**Suggested fix**: Change the structure and amend AC-15 to match. A common shape that iOS, Gmail and Outlook all read is `multipart/mixed` holding `multipart/alternative` (text, then `multipart/related` with the html and logo), then the `text/calendar; method=...` part as its own sibling, then the `invite.ics` attachment. Another option is to put the calendar alternative between text and html. Whichever is chosen, add a test that asserts the part order in the built MIME (the test today cannot see this class of bug), and retest on iOS Mail, Gmail app and Outlook before marking AC-23 done.

## Minor
### 🟡 A bad link in a testbed can roll back a booking or reschedule, `server/jobs/booking-notice.ts:82`
**Problem**: `queueBookingNotice` runs inside the booking transaction and calls `BookingEmailDetails.parse`, which requires every portal, LMS and client URL to be `https:`. If an older row holds a non https or malformed URL, the parse throws and the whole booking, confirm or reschedule fails with a server error. The admin forms enforce `HttpsUrl`, but the database has no check.
**Why it matters**: AC-7 says nothing outside the booking may refuse or undo it. A data problem on a testbed would block bookings on that testbed instead of only affecting the email.
**Suggested fix**: Either add a CHECK on the URL columns, or have the queue step fall back to a safe snapshot (links dropped, or the email row marked `failed` with a fixed reason) instead of throwing in the transaction. Cancels are not affected, since `links` is null there.

### 🟡 A returning learner who books as a guest gets emails in the stored zone, not the picked one, `server/db/guest-saga.ts:22`
**Problem**: The guest saga inserts the user with `onConflict(lower(email)).doNothing()`, so an existing learner keeps `users.timezone`. The success screen uses the zone picked in the form, but the email uses `users.timezone` (AC-11, so it matches the spec).
**Why it matters**: The learner sees one time on screen and a different time zone in the email for the same booking. The times are the same instant, so nothing breaks, but it looks like a mistake. It is rare, since a returning learner is normally asked to sign in.
**Suggested fix**: Keep as is and say so in the success screen copy, or show the stored zone on the screen for a claimed account. No code change is required for the spec.

### 🟡 An outage longer than about two hours fails emails for good, `server/jobs/runner.ts:24`
**Problem**: Backoff is 1, 2, 4, 8, 16, 32, 64 minutes, then the 8th failure marks the job and its email `failed`. A token endpoint or Gmail outage (429, 5xx, timeout) counts every try. There is no resend control in the console.
**Why it matters**: The spec allows this, but a long Google outage turns into permanent lost confirmations that an admin can only see, not retry.
**Suggested fix**: Consider not counting attempts that failed on `unavailable` before a request was sent, or raising the cap, or adding a console "retry" later. At least note it in the spec's consequences.

### 🟡 The step can outlast its 60 second timeout in the worst case, `server/jobs/runner.ts:400`
**Problem**: The 40 second budget is checked before each claim, but one send can take up to about 40 seconds on its own (mint 10s, call 10s, then a 401 repeat of both) plus render time. Started at 39 seconds, it passes the 60 second `STEP_TIMEOUT_MS`. `withTimeout` abandons the promise without cancelling it, so the old loop can keep running while the next tick starts another "jobs" step.
**Why it matters**: Claims use `SKIP LOCKED`, so no job runs twice, but two loops share the token cache and the marker writes, and the lease (5 minutes) is the only guard. Rare, and harmless in practice.
**Suggested fix**: Stop claiming after about 15 seconds, or pass the remaining budget into the job as an abort signal.

### 🟡 The "Set your password" box and the booked intro are wrong for reschedules and returning learners, `server/email/templates/lab-access-email.tsx:54`
**Problem**: The rescheduled email keeps the intro "your reservation is confirmed" under the heading "Your reservation was rescheduled", and the box says "You will receive a separate email with a link to set your password", which is false for a reschedule and for any existing user. No welcome email exists yet (feature 16).
**Why it matters**: Confusing copy in a message people will act on.
**Suggested fix**: Give the rescheduled kind its own intro ("Your reservation was moved. Here are the new details."), and show the password box only for `booked`, or only when the welcome email is built.

### 🟡 No test pins the final MIME structure or the Playwright helper texts, `server/email/compose.test.ts:76`, `e2e/api-keys.spec.ts:269`
**Problem**: Snapshots cover the html, text and `.ics` separately, and the compose test only checks that `multipart/alternative` appears. That is how finding one passed 1435 tests. The GOOGLE Playwright test does not check the AC-1 helper texts or the Dev inbox and Ops BCC fields.
**Why it matters**: The iOS failure and any later MIME change are invisible to the suite.
**Suggested fix**: Assert part order and content types in the composed message, and add the helper text and the two optional fields to the Playwright check.

## Nits
- ⚪ `lib/format-time.ts:43`, a UTC learner reads "GMT+0" in emails while the booking screens say "UTC". Special case `UTC` (or accept it and note it in AC-14).
- ⚪ `server/jobs/runner.ts:445`, the thrown error message is logged raw. Today none of the callees can echo a Google secret, but a Postgres detail could echo row data; consider logging only the error name and code.
- ⚪ `server/jobs/runner.ts:321`, `date_trunc('milliseconds', secret_updated_at)` cannot use an index. Harmless on a one row table.
- ⚪ `scripts/authentik-setup.ts` now PATCHes the adopted HOL Labs provider, application, policy and binding on `--apply`. It is a dry run by default and the owner approves shared changes, so this is fine, but the pre existing objects must not be changed in an agent run without asking.
- ⚪ `server/jobs/send-email.ts:77`, a Gmail timeout is treated as a retry, so a send Gmail did accept can go out twice. The spec accepts this and the `Message-ID` makes it visible; a short comment at the call would save the next reader a search.

## Strengths
- The outbox is built correctly: the notice, its email row and the calendar job are written inside the booking transaction in the three functions every caller already uses, with idempotency keys and a unique index, and Google is never called inside a booking transaction.
- The job runner is careful: one statement claim with `SKIP LOCKED`, the attempt cap respected, an exhausted lease sweep, the version order rule written into the claim, every failed path sets the email row `failed` in the same transaction, and the breaker gives the attempt back.
- The Google sign in flow is sound: PKCE, `state` compared with `timingSafeEqual`, an encrypted cookie bound to the admin id with the right flags, the 10 minute check against the DB clock, the client id match, and the cookie kept or cleared on exactly the paths the spec lists. Errors carry fixed messages, and the refresh token appears only in the three allowed files.
- The marker writes (`markGoogleRejected`, `clearGoogleRejected`) are guarded by `secret_updated_at`, run outside the job transaction, and never change a job's outcome. The token cache is keyed by that stamp.
- The api keys catalog edit and switch rules are exhaustive, with typed codes and `never` checks, and the audit lists never hold a secret.
- Spec 0012 reads are scoped to the session learner, name their columns (no OS logins), and the reconciler revokes only after the group removal, with the audit written last.

## Test coverage
Strong. `server/jobs/jobs.test.ts` (about 1000 lines) covers claiming, the attempt cap, backoff, the lease sweep, the version order rule, the breaker and the marker. There are action tests with canary secrets, token and verify tests, a worker hook test, and source scans for the secret column, the Google key and the refresh token. Gaps: the built MIME structure and part order, the `BookingEmailDetails.parse` failure inside a booking transaction, and the Playwright GOOGLE helper texts and optional fields.

## Notes on today's runtime findings
- a. Confirmed in code and ranked Major above. It follows AC-15 as written, so the spec needs an amendment together with the fix.
- b. Spec conformant (AC-11). Ranked Minor.
- c. Confirmed (`lab-access-email.tsx:54`). Ranked Minor, merged with the password box copy.
- d. Confirmed. A Nit.
- e. Confirmed. Merged into the test Minor.

## Spec 0011 follow up check
The 2026-10-13 review had two minors and nits, no blockers or majors. The follow up section in that file states each was answered (same_time order kept and pinned by a test, the retry shortcut explained in a comment, `CancelInput.version` made `.positive()`, spec status set to Accepted). Nothing further needed.
