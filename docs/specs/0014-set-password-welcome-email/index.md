# 0014. Set password and welcome email

**Date**: 2026-10-17
**Status**: Accepted
**Amends**: [spec 0002](../0002-data-model/index.md) (the one welcome per user index on `email_messages` is dropped; welcome `details` defined here), [spec 0003](../0003-authentik-sign-in-provisioning/index.md) (AC-6: the Authentik recovery link is requested when the learner clicks, for 10 minutes, and the 72 hours move to the app's own link; `hol-recovery` gains a login stage; `onAPIError.errorURL` sends every early callback failure to `/auth/error`, which gains a `timed_out` view with a Sign in button, AC-19), [spec 0008](../0008-admin-users/index.md) (the known gap "a link sent to the old address stays valid" is closed: an email change ends the learner's links; the email change job key gains the change's DB time), [spec 0013](../0013-email-delivery-booking-confirmations/index.md) (the `send_welcome` handler joins the runner's handled set and reuses `EmailFrame`).

## Summary

A new learner gets one email with a button to set their password. The button opens a page in the app (not Authentik), and the app keeps only a fingerprint of that link, so it can make the link work once, expire after 72 hours, and stop working the moment an admin fixes the learner's email. When the learner clicks, the app asks Authentik for a fresh 10 minute set password page and sends them there; after the password, Authentik signs them in and returns them to the app, signed in and verified. Several queued welcome jobs for one learner (add, resend, email fix) collapse into one email, so nobody gets two at once.

## Requirements

**User stories**:
- As a new learner, I want one clear email with a button that lets me set a password and lands me signed in, so I can see my lab access and manage my reservation.
- As an admin, I want a fixed typo in a learner's email to stop the old link from working, so a stranger who got the first email can't take the account.
- As a learner whose link went stale, I want to ask for a new one right where the old one failed.

**Acceptance criteria**:

*Sending (worker)*
- **AC-1**: `send_welcome` is in the worker's `HANDLERS` (spec 0013 AC-8). The handler runs in the job's transaction and reads the user `FOR SHARE`. It sends only to an active learner (`role = 'learner'`, `status = 'active'`) with an Authentik pk and `set_password_pending = true`; anyone else finishes the job `done` with no email row and no link.
- **AC-2**: A job whose payload has no `appUrl` (queued before this feature) finishes `done` with no email row and no link. A job for an eligible user (AC-1) queued more than 72 hours ago (`jobs.created_at` against `dbNow`) finishes `done` with no link and one `suppressed` welcome row whose `last_error` is `Not sent: queued over 72 hours ago. Resend from the user page.`, so a long outage shows in the console. `ClaimedJob` gains `createdAt` (`claimJob`'s `returning` and the `JobRow` schema add `created_at`).
- **AC-3**: One send per user at a time. Before sending, the handler reads the user's current `email`. If a `welcome` row for this user exists with `status in ('sent', 'suppressed')`, `lower(to_address) = lower(<current email>)`, and `created_at >= <this job's created_at>`, the job finishes `done` and sends nothing. An unsent original plus an email change job sends exactly one email, to the new address. A resend queued after an earlier send still sends.
- **AC-4**: Each email carries a new link. The token is 32 random bytes from `crypto.randomBytes`, encoded base64url (43 characters). The app stores only `sha256(token)` in `set_password_links.token_hash`, plus `email = lower(users.email)` and `expires_at = <DB now> + 72 hours`. The URL is `<payload.appUrl>/set-password/<token>`. The raw token and the URL are never written to the DB, a log, `last_error`, audit metadata, or `email_messages.details`.
- **AC-5**: Routing reuses `routeEmail` (spec 0013 AC-16, AC-36). A test address goes to the dev inbox with the `[dev] ` subject prefix, or is suppressed (a `suppressed` row, no link) when no dev inbox is set. **A welcome never gets the Ops BCC**, whatever the key's setting.
- **AC-6**: Outcomes follow the runner (spec 0013): with no `GOOGLE` key the job waits. The runner commits the job's transaction on every outcome, so the handler writes **nothing before the Gmail call**: it builds the token, the row id (`crypto.randomUUID`, shared by the MIME message and the row), and the message in memory, sends, then writes. On `retry` or `breaker`, it writes nothing. On a final refusal, it writes a `failed` row and no link. On success, it writes the `sent` row (`sent_to = route.to`, `provider_message_id`, `sent_at = now()`) and the link row pointing at it. Every welcome row sets `user_id`, `job_id = job.id`, `kind = 'welcome'`, `to_address = users.email` as stored, and `subject` = the AC-7 constant with no `[dev] ` prefix. `sent_to` is null unless sent. `last_error` reuses the fixed texts of `send-email.ts` (`GMAIL_RETRY`, `gmailRefused`, now exported) or the routing reason. Accepted: a crash or failed commit after Gmail accepts the message leaves a mailed link with no stored hash (Dead), and the retry mails a second, working one.
- **AC-7**: The template (React Email, reusing `EmailFrame`, `CtaButton`, `NileFooter`), HTML and plain text parts in `multipart/alternative`, no attachment:
  - Subject: `Set your password for Nile Hands-On Labs`.
  - Hidden preview line: `Set a password to manage your Nile Hands-On Lab reservations.`
  - Nile logo, heading `Set your password`.
  - Body: `Hi <first name>, your Nile Hands-On Labs account for <email> is ready. Set a password to view your lab access and reschedule or cancel reservations.`
  - Button `Set my password` linking to the AC-4 URL.
  - Note: `This link works once and expires <expiry>.`, with `<expiry>` from `formatDateTime(expiresAt, users.timezone)` (`lib/format-time.ts`; UTC prints `UTC`).
  - Fallback: `Button not working? Paste this link into your browser:` then the URL as text.
  - `Didn't expect this? You can ignore this email.`, then the Nile footer.
- **AC-8**: `email_messages.details` for `welcome` is `WelcomeEmailDetails` in `lib/welcome-email.ts`: `{ name: string, expiresAt: string (ISO), timeZone: string (IANA) }`. It never holds the token or the URL. The console Emails section (spec 0013 AC-21) lists welcome rows unchanged.

*The click (web)*
- **AC-9**: `GET /set-password/[token]` (`app/set-password/[token]/page.tsx`, `params` awaited as a Promise) is public, `noindex, nofollow` (root default), `referrer: strict-origin` (amended 2026-10-18; not `no-referrer`, which makes the browser send `Origin: null` on a native form POST, so Next refuses the action), and `force-dynamic`. It reads state without changing anything through one function, `linkState(conn, token)` in `server/auth/set-password-links.ts`, which the action also uses. It shows one of:
  - **Live**: the token parses, its hash matches a link with `ended_at is null` and `expires_at > now()`, the user is an active learner with a pk and `set_password_pending = true`, and `link.email = lower(users.email)`. It shows heading `Set your password`, the line `for <link.email>`, a `Set my password` button, and the helper `You'll choose a password on Nile's sign in page, then come straight back here signed in.` The button is a client component that uses `useActionState` and `useFormStatus`, disabled while the action runs.
  - **Already set**: the hash matches a link that is live or ended `used` or `other_used` (expired or not), the user is an active learner with `set_password_pending = false`, and `link.email = lower(users.email)`. It shows `Your password is already set.` and a `Sign in` button (`signInWithSso`). So a learner who opens the email again after signing in gets a way in, not a resend form that can't help them.
  - **Dead**: anything else (unknown, malformed, expired or used while still pending, ended `email_changed`, deactivated, address mismatch). It shows `This link has expired or was already used.` and the existing `ResendSetPassword` form below it (site key from `turnstileEnv()`). One message for every case.
- **AC-10**: `startSetPassword(token, prev, form)` in `app/set-password/[token]/actions.ts` (a Server Action; the page binds the token, which is checked against the base64url, 43 character shape) is on the public allow list. It returns `{ state: "dead" | "already_set" | "unavailable" | "limited" }` for `useActionState`, or redirects. Steps:
  1. If `set-password:miss:<clientIp()>` already holds 30 attempts this hour (read only, through the `rate_limits` counters), return `limited`: `Too many attempts. Try again in an hour.`
  2. Read the link by `token_hash` with no lock. No match, or not Live: count one miss on that key (`countHourlyAttempt`), then return `dead` or `already_set` (AC-9). Only misses count, so a class behind one NAT, or the shared `untrusted` IP bucket, never blocks real clicks. Authentik is called only for live links.
  3. One transaction inside `refusable()`, locked user first, as `updateLearner` is: lock the user `FOR SHARE`, then the link `FOR UPDATE`, and recheck Live. A miss throws `Refusal("dead")`.
  4. Call `issueSetPasswordLink(api, pk, "minutes=10")` (guarded, while holding the locks, per the lock first pattern). A guard refusal throws `Refusal("dead")`. `unavailable` throws `Refusal("unavailable")`, so the link stays live and the page shows `Sign in is unavailable right now. Try again in a minute.`
  5. Start sign in with `auth().api.signInSocial` (as `signInWithSso`: provider `authentik`, `callbackURL: "/auth/landing"`, `errorCallbackURL: "/auth/error"`, `disableRedirect: true`). This sets the state cookie on the clicked app host. A later rollback leaves an orphan state row that simply expires, which is harmless.
  6. Require the authorize URL's origin to equal the recovery link's origin, or throw (a broken invariant: `AUTHENTIK_URL` and the issuer must name the same public host).
  7. End this link (`used`) and every other live link of the user (`other_used`). Return the target URL from the transaction: `new URL(recoveryLink)` with `searchParams.set("next", authorize.pathname + authorize.search)`.
  8. After `refusable()` returns `ok`, call `redirect(target)`, outside the transaction, since `redirect` throws.

  An app session already open in that browser is replaced by the new sign in.
- **AC-11**: `npm run authentik:setup` makes `hol-recovery` exactly: prompt (order 10), user write (20), and a new user login stage `hol-recovery-login` (30, `session_duration: "seconds=0"`, a browser session). After the password, Authentik signs the learner in, follows `next` to the authorize endpoint, and passes through `hol-authorization` with no prompt to the app's callback. `onSessionCreate` sets `email_verified_at` and clears `set_password_pending` (spec 0003 AC-7), and `/auth/landing` lands the learner on `/reservations`. **Fallback**, used only if build task 1 shows Authentik drops `next` on a token flow: add a Redirect stage `hol-recovery-return` (order 40, static target `<first APP_URLS>/auth/start`) and a public `GET /auth/start` route that starts sign in like `signInWithSso`; the action then adds no `next`.
- **AC-12**: Works once. After a successful click, no link of that user starts the flow again: each shows Dead while the learner is still pending, or Already set once they have signed in. The Authentik link is asked for 10 minutes and is used up when its flow opens. Authentik keeps one recovery token per user, so a click while an earlier token is unexpired may get that token back with its own expiry. Task 1 checks both behaviors.
- **AC-13**: Any live link of a user works (the first email or a resend); the first successful click ends all the others (`other_used`).
- **AC-14**: An email change in `updateLearner` (spec 0008 AC-6) ends every live link of that user (`email_changed`) in the same transaction, after its user lock and before it queues the welcome job. That job's key becomes `welcome:<id>:email:<lower email>:<dbNow(trx) epoch ms>`, so a fix that goes X to Y, back to X, then to Y again still queues a job for the second Y. The handler's `FOR SHARE` waits for the change to commit. The click's `link.email` check is the backstop for any link whose address no longer matches.
- **AC-15**: Every `enqueueWelcome` caller passes `appUrl()` into the payload `{ userId, appUrl }`: `server/booking/guest-booking.ts`, `server/users/learners.ts` (add, resend, email change), and `app/reservations/actions.ts`. They import from `server/jobs/welcome-queue.ts` (`enqueueWelcome`, `welcomeKey`, `resendKey`, `emailChangeKey`, `sendWelcomePayload`). The old `runSendWelcome`, `SetPasswordEmail`, and their tests in `send-welcome.ts` are replaced by the handler. The keys `welcome:<id>` and the resend hour bucket stay as they are.

*Housekeeping and proof*
- **AC-16**: The worker's purge step deletes `set_password_links` whose `expires_at < now() - interval '30 days'`.
- **AC-17**: The worker's smoke check (spec 0013 AC-22) also renders the welcome template.
- **AC-18**: Tests prove the raw token and the `/set-password/` URL appear in no `email_messages` column, `jobs.payload`, audit row, or log line written by the handler or the action, and that `startSetPassword` is on the allow list in `tests/server-actions-require.test.ts`.
- **AC-19**: A learner who takes longer than 5 minutes from the click to set the password comes back with an expired sign in. Better Auth 1.7.7 uses the database state strategy here (the app has an adapter): the signed `state` cookie lives 300 seconds and the `verification` row 10 minutes, both fixed inside Better Auth. From 5 to 10 minutes the cookie is gone, and the callback redirects to `/auth/error?error=state_mismatch`. After 10 minutes the row may already be deleted (any verification lookup clears expired rows). Better Auth then throws without our `errorCallbackURL` and falls back to its own `/api/auth/error`, so:
  - **Config**: `server/auth/index.ts` sets `onAPIError: { errorURL: "/auth/error" }` in `betterAuth(...)`. Every callback failure that happens before the state is read (row gone, no `state`) then lands on `/auth/error?error=<code>` too, not on Better Auth's page or `/?error=` (this also changes spec 0003's sign in, for the better).
  - **View**: `lib/auth-errors.ts` adds `timed_out` to the `views` record: title `Sign in timed out`, message `Your sign in expired before it finished. Sign in again to continue.`, `reserveLink: false`, `signIn: true`. `AuthErrorView` gains `signIn: boolean`, which is `false` on every other view.
  - **Mapping**: `authErrorView` keeps `reason ?? error` precedence and maps the `error` code `state_mismatch` (only) to `timed_out`. `reason=timed_out` also shows it, which is harmless. Every other code keeps its current view, and unknown codes still read as `unavailable`.
  - **Page**: `app/auth/error/page.tsx` stays a server component. When `view.signIn` is true, it renders a `<form action={signInWithSso}>` with a shadcn `Button` `Sign in` (as the Already set view does, AC-9), then the existing `Back to the home page` link. There is no session check: if a session already exists, the new sign in replaces it.

  The button signs the learner in with no password prompt (the Authentik session from AC-11). `state_mismatch` also covers a sign in finished in another browser, or `APP_URL` not matching the browser's host. The same view fits there, and it repeats only when clicked, never in an automatic loop. Accepted and checked in `verify.md`.

## Decision

**Chosen option**: an app link handed off on click, plus a login stage and `next` back to the app's own authorize request (rationale Option 1).

The email links to the app's own one time page. The app keeps a hash with expiry and end state, asks Authentik for a 10 minute recovery link only when the learner clicks, and sends Authentik back to the authorize endpoint so the learner lands signed in. Several welcome jobs collapse at send time, and an email change ends links in the app with no new Authentik rights.

**Implementation skills**: `react-email` (`resend/react-email`, `.claude/skills/react-email/`) · `kysely` (`mindrally/skills`, `.claude/skills/kysely/`) · `supabase-postgres-best-practices` (`supabase/agent-skills`, `.claude/skills/supabase-postgres-best-practices/`) · `zod` (`pproenca/dot-skills`, `.claude/skills/zod/`) · `better-auth-best-practices` (`better-auth/skills`, `.claude/skills/better-auth-best-practices/`) · `vitest` (`antfu/skills`, `.claude/skills/vitest/`) · `playwright-best-practices` (`currents-dev/playwright-best-practices-skill`, `.claude/skills/playwright-best-practices/`) · `gws-gmail` (`googleworkspace/cli`, `.claude/skills/gws-gmail/`)

## Rationale

Reasoning and options: see [rationale.md](rationale.md).

## Feature design

### Data model sketch

New table `hol_app.set_password_links` (migration `0011_set_password_links.sql`, RLS on, no policies):

| Column | Type | Null | Notes |
|---|---|---|---|
| id | uuid | no | PK, `gen_random_uuid()` |
| user_id | uuid | no | `set_password_links_user_id_fkey` → `users(id)` `on delete cascade` |
| email_message_id | uuid | no | `set_password_links_email_message_id_fkey` → `email_messages(id)` `on delete cascade`; unique `set_password_links_email_message_id_uq` (1:1) |
| token_hash | bytea | no | `sha256(token)`; unique `set_password_links_token_hash_uq` |
| email | text | no | `lower(users.email)` when sent |
| expires_at | timestamptz | no | DB `now() + interval '72 hours'` |
| ended_at | timestamptz | yes | set once |
| ended_reason | text | yes | `set_password_links_ended_reason_check`: `used` \| `other_used` \| `email_changed`; `set_password_links_ended_together`: `(ended_at is null) = (ended_reason is null)` |
| created_at | timestamptz | no | `now()` |

Indexes: `set_password_links_live_user_idx (user_id) where ended_at is null` (end all, email change); `set_password_links_expires_at_idx (expires_at)` (purge). `lib/db-enums.ts` gains `SetPasswordLinkEndReason`, registered in `checkLists` as `set_password_links.ended_reason`.

Existing tables, no schema change:
- `email_messages`: welcome rows (`booking_id` and `booking_version` null) are written **by the handler at send**, not at queue. Spec 0002's unique `(user_id) where kind = 'welcome'` is not built. Email rows are never purged, so the `email_message_id` cascade never removes a live link.
- `jobs`: `send_welcome` payload becomes `{ userId: uuid, appUrl: url }`; `appUrl` is optional in the parser so older rows are read and skipped (AC-2).
- `users`: read only here (`email`, `name`, `timezone`, `role`, `status`, `authentik_user_pk`, `set_password_pending`).

Relationships: `users` 1:N `set_password_links`; `email_messages` 1:1 `set_password_links` (welcome rows that were sent).

### State transitions

`set_password_links`: **live** (`ended_at` null, `expires_at > now()`) → **ended** `used` (clicked) · `other_used` (a sibling was clicked) · `email_changed` (admin fix). Live → **expired** by time alone, with no write. Ended or expired rows are purged 30 days after `expires_at`. Nothing ever returns to live.

Learner identity (spec 0003, unchanged): created with no password → **link clicked** → password set in `hol-recovery` → signed in (verified, pending cleared).

### API surface

| Surface | Kind | Key inputs | Key outputs | Auth | Key errors |
|---|---|---|---|---|---|
| `send_welcome` handler (`server/jobs/send-welcome.ts`, worker only) | job | payload `{ userId, appUrl }`, `ClaimedJob.createdAt` | one email, `email_messages` row, link row | worker | `done` (skip), `retry`, `final`, `breaker` |
| `enqueueWelcome` (`server/jobs/welcome-queue.ts`, web safe, no renderer import) | function | `conn`, `userId`, `idempotencyKey`, `appUrl` | job row (repeat key is a no op) | caller's | none |
| `endLiveLinks` (`server/auth/set-password-links.ts`) | function | `trx`, `userId`, reason, except id (optional) | count | caller's | none |
| `/set-password/[token]` | page GET | `params.token` | Live, Already set, or Dead view | public | Dead for every miss |
| `startSetPassword` (`app/set-password/[token]/actions.ts`) | Server Action, token bound | none | redirect to Authentik, or a view state | public (allow list), miss limit per IP | `dead`, `already_set`, `unavailable`, `limited` |
| `issueSetPasswordLink` (`server/authentik/learners.ts`) | function, changed | `api`, `pk`, `tokenDuration` | recovery link | provisioning token, guarded | `unavailable`, guard refusals |
| `composeWelcomeEmail` / `renderWelcomeEmail` (`server/email/compose.ts`) | function | details, URL, subject, routing | MIME raw, HTML, text | worker | none |
| `GET /auth/start` | route | none | redirect to Authentik | public | fallback only (AC-11) |
| `/auth/error` page (`app/auth/error/page.tsx`, changed) | page GET | `error=state_mismatch` (new mapping), `reason` as before | `timed_out` view with a Sign in form (`signInWithSso`) | public | none (AC-19) |
| Better Auth config (`server/auth/index.ts`, changed) | config | `onAPIError.errorURL: "/auth/error"` | early callback failures land on `/auth/error?error=<code>` | n/a | none (AC-19) |

### Value sourcing

| Action | Value | Source |
|---|---|---|
| handler | eligibility, recipient, name, zone | `users` row (`FOR SHARE`) |
| handler | first name | `firstName(users.name)` (`lib/manage-reservations.ts`) |
| handler | job age | `jobs.created_at` (new `ClaimedJob.createdAt`) against `dbNow(trx)` |
| handler | covered already | `email_messages` welcome rows for the user (AC-3) |
| handler | token, hash | `crypto.randomBytes(32)` base64url; `sha256` |
| handler | expiry | `dbNow(trx) + 72 hours`, stored in `expires_at` and `details.expiresAt` |
| handler | expiry text | `formatDateTime(expiresAt, users.timezone)` |
| handler | link base | `payload.appUrl` (the queuing process's `appUrl()`, since one worker serves dev and prod, as booking emails' `details.appUrl`) |
| handler | subject, copy | constants in `lib/welcome-email.ts` and the template |
| handler | to, `[dev] ` prefix | `routeEmail(users.email, ctx.cfg)`; bcc forced to none |
| handler | sender, token for Gmail | `ctx.cfg.senderEmail`, `ctx.google` (spec 0013) |
| page | state, email shown | `set_password_links` joined to `users`, DB `now()` |
| action | IP | `clientIp(await headers())` |
| action | Authentik recovery link | `issueSetPasswordLink(api, users.authentik_user_pk, "minutes=10")` |
| action | authorize path | `signInSocial(...).url` pathname plus search |
| landing | verified, pending cleared | `onSessionCreate` (spec 0003 AC-7) |
| error page | which view, whether to show Sign in | `authErrorView({ reason, error })` from the query string (`reason` first); `signIn` from the view |
| callback | where an early failure goes | `onAPIError.errorURL` (`/auth/error`), else the per sign in `errorCallbackURL` Better Auth read from the state |

### Key invariants

- The raw token exists only in the worker's memory during the send and in the learner's inbox and browser. At rest it is a sha256 hash.
- A link is live only while `ended_at is null`, `expires_at > now()` (DB clock), the user is an active learner with `set_password_pending = true`, and `link.email = lower(users.email)`. The page and the action use the same predicate (one function).
- `ended_at` is written once; nothing clears it.
- Lock order is user first, then links, in the handler (user `FOR SHARE`), the click (user `FOR SHARE`, then link `FOR UPDATE`), and the email change (user `FOR UPDATE`, then the link update), so the three never deadlock.
- At most one welcome email per user per covered request (AC-3); the worker runs one job at a time, so the check needs no extra lock.
- The Authentik recovery link is never stored, logged, or mailed; it lives for one redirect.
- The web process never imports the renderer: queuing lives in `welcome-queue.ts`, the handler in `send-welcome.ts`.

### Security model

- The click page and action are public. The token is the only credential, with 256 bits of entropy and a single use. The miss limit (30 misses per IP per hour) only slows a script that is probing tokens; live clicks never count.
- The dead view never says why, so an old or stolen token reveals nothing beyond "not live". The live view shows the address, which the token holder already has.
- No Ops BCC on welcome emails: a copy would be a working sign in for someone else's account.
- `issueSetPasswordLink` stays guarded, so a link is never issued for an admin or an untagged user.
- An email change ends links in the app. No new Authentik permissions are added (no token view or delete); the provisioning role is unchanged.
- `hol-recovery` now signs the learner in, so the flow is a sign in path. It is reachable only through a recovery link the app issues to a guarded learner.
- `referrer: strict-origin` keeps the token out of Referer headers: every request from the page carries only the origin, whether it goes to our own server, the Turnstile script (which loads on the Dead view), or Authentik after the click's redirect. An https page never sends even the origin to http; on dev (http to http) the origin still goes, which is harmless. The page's `<meta name="referrer">` sets the policy; any `Referrer-Policy` response header that reaches this route (from `next.config.ts`, `proxy.ts`, or a reverse proxy) must also be `strict-origin`, because a header overrides the meta tag. Any change to this policy must keep a real `Origin` on a native form POST; `e2e/set-password-public.spec.ts` checks both.
- Accepted: the token appears in the path of access logs (Cloudflare, Next). It is single use and expires in 72 hours.

### Configuration required

- No new env vars or credentials. The worker needs no Authentik access for welcome emails.
- `npm run authentik:setup -- --apply` changes the shared `hol-recovery` flow (one new stage and binding, plus the fallback's Redirect stage if used). The owner runs or approves the apply.

### Critical test scenarios

- Happy path (DB plus fake Authentik plus fake Gmail, then Playwright): a guest booking queues a job; the handler sends one email with a live link; the click redirects to the recovery link with `next`; the link and its siblings end. Playwright drives a fresh `hol-test-` learner's link through Authentik to `/reservations`, signed in. Verifies **AC-1**, **AC-4**, **AC-6**, **AC-9**, **AC-10**, **AC-11**, **AC-13**.
- One send: original plus email change job gives one email to the new address; a resend after a send gives a second email; a test address with no dev inbox gives a single suppressed row. Verifies **AC-3**, **AC-5**, **AC-15**.
- Stale: a job over 72 hours old sends nothing and leaves one suppressed row with the AC-2 reason; one with no `appUrl` leaves no row. Verifies **AC-2**.
- Email fix there and back: X to Y to X to Y queues a job for the second Y, and exactly one live link exists afterward, for Y. Verifies **AC-14**.
- Gmail outcomes: retry and breaker write nothing; final writes one failed row with no link. Verifies **AC-6**.
- Email change: links end `email_changed`; the old token shows Dead; a link row inserted directly with the old address shows Dead (the backstop). Verifies **AC-14**.
- Click failures: Authentik unavailable keeps the link live, and a second try works; a guard refusal gives Dead; a used token while pending, an expired token (DB clock), a deactivated user, and a malformed token all give the same Dead view; a used or expired token after first sign in gives Already set; 30 misses from one IP give `limited` on the next POST, while live clicks from that IP never count. Verifies **AC-9**, **AC-10**, **AC-12**.
- Lock order: a click and an email change on the same learner, run at the same moment, both finish (no deadlock); the click either wins (Authentik link issued) or sees Dead. Verifies **AC-10**, **AC-14**.
- Template: snapshot of HTML and text; the MIME tree has `multipart/alternative` with no attachment; the subject; no BCC header for a real address; the expiry in the learner's zone. Verifies **AC-5**, **AC-7**, **AC-8**.
- Leaks and auth: the AC-18 scans; the allow list. Verifies **AC-18**.
- Purge and smoke: rows 31 days past expiry go, 29 days stay; the worker smoke renders welcome. Verifies **AC-16**, **AC-17**.
- Timed out view (pure, `lib/auth-errors.test.ts`): `error=state_mismatch` gives `timed_out` with `signIn: true` (the existing case that expects `unavailable` for it is rewritten); `error=state_invalid`, another unknown `error` code, and `reason=unavailable` still give `unavailable`; `reason=unavailable&error=state_mismatch` gives `unavailable` (reason first); every other view has `signIn: false`. By hand: a bogus `state` on the callback lands on the timed out view (the `onAPIError` path). Verifies **AC-19**.

## Build plan

Tracer Bullet: prove the risky Authentik round trip first, then one real email through every layer, then thicken.

1. **Authentik spike, on dev, recorded in `verify.md`**: by hand against the shared Authentik, (a) ask for a recovery link with `tokenDuration: "minutes=10"`; (b) add `&next=<a relative authorize path from a real signInSocial>` and confirm Authentik follows it after the flow; (c) with a temporary user login stage on a throwaway copy of the flow, confirm the learner lands on the app signed in; (d) open the same recovery link a second time and confirm it no longer works; (e) ask twice within 10 minutes without opening it, and record whether Authentik returns the same token and which expiry wins; (f) confirm that the recovery link's origin and the discovery issuer's authorize origin are the same public host. Choose the main path or the AC-11 fallback from (b). Satisfies **AC-11**, **AC-12**.
2. **Tracer thread**:
   - Migration `0011`, `db:codegen`, `SetPasswordLinkEndReason`.
   - `lib/welcome-email.ts` (details schema, subject, token shape, URL builder), the `welcome-email.tsx` template, and `composeWelcomeEmail`.
   - `ClaimedJob.createdAt`; split `welcome-queue.ts` from `send-welcome.ts`; the `appUrl` payload in every caller.
   - The handler's eligible path, registered in `HANDLERS`.
   - `issueSetPasswordLink` takes a duration; `authentik:setup` adds `hol-recovery-login` (dry run, then the owner's apply).
   - `/set-password/[token]` Live view and the `startSetPassword` happy path.
   - Send one welcome to the dev inbox, click it, and land signed in.

   Satisfies **AC-1**, **AC-4**, **AC-7**, **AC-8**, **AC-9**, **AC-10**, **AC-11**, **AC-15**.
3. **Failure strands**: the Dead and Already set views with the resend form; the IP limit; the unavailable message with rollback; the guard refusal; Gmail retry, final, and breaker; the stale job and missing `appUrl` skips; routing with no BCC. Satisfies **AC-2**, **AC-5**, **AC-6**, **AC-9**, **AC-10**, **AC-12**.
4. **One send and revocation**: the AC-3 covered check; `other_used` on click; `email_changed` in `updateLearner`; the purge step; the smoke render. Satisfies **AC-3**, **AC-13**, **AC-14**, **AC-16**, **AC-17**.
5. **Proof**: template snapshots and the MIME tree test; the AC-18 leak scans and allow list; Playwright for the click to signed in path and the second click Dead; `verify.md` steps for iOS Mail and Gmail web (the matrix the owner accepted for spec 0013) and the AC-19 slow learner case. Satisfies **AC-5**, **AC-7**, **AC-11**, **AC-12**, **AC-18**, **AC-19**.
6. **Timed out view** (added 2026-10-17: the build found `/auth/error` had no sign in button for AC-19 to use, and the cross check found the 5 minute cookie and the fallback to Better Auth's own error page): `onAPIError.errorURL` in `server/auth/index.ts`; the `timed_out` view, `signIn` on every view, and the `state_mismatch` mapping in `lib/auth-errors.ts`; the Sign in form in `app/auth/error/page.tsx` (shadcn `Button`, above the home link); the pure cases in `lib/auth-errors.test.ts`, rewriting the old `state_mismatch` case; then run the two `verify.md` AC-19 steps. Satisfies **AC-19**.

## Consequences

**Positive**:
- Works once, expiry, and email change revoke are app rules backed by the DB clock, testable with no Authentik in the loop.
- The welcome send no longer depends on Authentik, only on Gmail, as the booking emails already do.
- No new Authentik permissions; spec 0008's known typo email gap is closed.
- Mail scanners that prefetch links can't use one up, because a GET changes nothing.
- The learner lands signed in and verified on the app URL they clicked, whether dev or prod.

**Negative / tradeoffs**:
- Authentik must be reachable at click time. An outage shows "try again" instead of the password page.
- A new public route and Server Action, plus a table, to own and test.
- A learner who opens the Authentik page and walks away has used their link and must ask for a resend.
- A learner who takes more than 5 minutes on the password page (Better Auth's fixed state cookie life) gets "Sign in timed out" and one more click (AC-19). Authentik's recovery link lasts 10 minutes, so the app's sign in is the shorter clock.
- Ops no longer sees a copy of welcome emails, only the console row.
- The shared `hol-recovery` flow now signs users in; anyone who reaches it with a valid token gets a session, not just a password.
- If the fallback is needed, dev clicks land on the first `APP_URLS` entry.

**Neutral**:
- Old `send_welcome` jobs older than 72 hours, or with the old payload, finish without sending; affected learners can resend.
- `send-welcome.ts` splits in two so the web process never loads the renderer.
- Spec 0003's "never store the link" still holds for the Authentik link; the app now stores a hash of its own link.

## Follow-up

- [ ] After build task 1, record which landing path was used (main or fallback) in this spec and in `server/authentik/AGENTS.md`.
- [ ] `/sync`: these lines go stale with this build:
  - in `server/jobs/AGENTS.md`, the `send-welcome.ts` row ("no handler is registered until feature 16") and "Real addresses get the ops BCC" (not for welcome);
  - in `server/authentik/AGENTS.md`, "Recovery links are asked for with `hours=72`" (now `minutes=10` at click);
  - the `HANDLERS` comment in `worker/index.ts`.

  Add `welcome-queue.ts`, `server/auth/set-password-links.ts`, and the user first lock order for links.
- [ ] Accepted: `hol-recovery` now signs in anyone holding a recovery token, including a link an Authentik admin makes by hand for a learner (that signs them in to Authentik, not to the app).
- [x] The next `/check verify` covers the AC-9 referrer amendment (2026-10-18): run `e2e/set-password-public.spec.ts` beside `e2e/set-password.spec.ts`, and click `Set my password` on dev before the page hydrates.
- [ ] The scope's done criterion "the link expires, works once, and lands them signed in" is met by AC-11 to AC-13. If the fallback is used, the e2e test targets the first `APP_URLS` entry.
