# 0013. Email delivery and booking confirmations

**Date**: 2026-10-14
**Status**: In Progress
**Amends**: [spec 0001](../0001-stack-architecture/index.md) (Google credentials move from env files to the API Keys screen; the dev OAuth driver is dropped and the service account with domain wide delegation is the only driver), [spec 0002](../0002-data-model/index.md) (`integration_secrets` is dropped from the target; `api_keys` gains Google columns; `email_messages` is built), [spec 0006](../0006-admin-api-keys/index.md) (a fourth key type, `GOOGLE`)

## Summary

Learners get one email each time their booking is made, moved, or cancelled. The email uses the mock's templates and carries a calendar invite that adds, moves, or removes the event in their own calendar. Every booking is also copied onto one shared "HOL bookings" Google calendar so admins see the week. Mail is sent by the background worker through the Gmail API as one HOL mailbox. Its Google credential is a service account key (a JSON file from Google Cloud for a robot account allowed to act as that mailbox), uploaded once on the API Keys page as a `GOOGLE` key with the sender mailbox typed beside it. It is stored encrypted and only the worker ever unlocks it. Sending happens after the booking change commits, so a Google outage delays email but never undoes a booking. Admins see each learner's email history on the learner's page.

## Requirements

**User stories**:
- As a learner, I want a confirmation with a calendar invite when I book, reschedule, or cancel, so my calendar always matches my reservation.
- As an admin, I want to set up Google sending once on the API Keys page, with the credential checked as I save it, so a mistake shows at once and not as silent failed mail.
- As an admin, I want to see each email a learner was sent and whether it went out, so I can answer "I never got anything".
- As an admin, I want every booking on one shared calendar, so I can see the week at a glance.
- As the owner, I want the Google credential stored encrypted and unlocked only by the worker, and dev and test bookings never to email real people.

**Acceptance criteria**:

*The GOOGLE key (amends spec 0006)*

- **AC-1**: `ApiKeyType` gains `GOOGLE`. Choosing it in the Add API Key dialog replaces Base URL and Key value with: **Key file** (a file input, `accept=".json,application/json"`, the service account JSON key downloaded from Google Cloud, AC-3), **Sender mailbox** (email, required, helper "The Workspace mailbox emails come from. The service account acts as it."), **Calendar ID** (text, required), **Dev inbox** (email, optional, helper "Test and dev- bookings are sent here. Leave blank to not send them."), and **Ops BCC** (email, optional, helper "Gets a copy of every learner email."). On create, a missing file is "Choose the key file." on `keyFile`. The server checks `file.size` before reading (at most 16 KB, else "The key file is too large."), then reads the file from the `FormData` and parses it per AC-3. Sender mailbox is trimmed, `z.email()` ("Enter an email address."), and stored as `sender_email`. `base_url` is stored as the constant `GOOGLE_BASE_URL = "https://www.googleapis.com"` and not shown in the form. Calendar ID is trimmed, 1 to 255 characters, no whitespace or `/` ("Enter the calendar ID from the calendar's settings."). Dev inbox and Ops BCC are trimmed, blank becomes null, otherwise `z.email()` ("Enter an email address."). At most one live `GOOGLE` key exists (`api_keys_one_google_uq`); `mapConstraintError` maps it to `google_exists`, shown on `type` as "Only one Google key can exist. Edit the existing one." The list shows `GOOGLE` with the `neutral` badge and its Base URL cell shows the sender mailbox instead of the constant.
- **AC-2**: Saving a `GOOGLE` key with a file runs, after Zod and outside any transaction, `verifyGoogleKey({ clientEmail, privateKey, privateKeyId, clientId, senderEmail, calendarId })`: it mints an access token as the sender (`google-auth-library` `JWT` with `subject` = the sender mailbox and scopes `https://www.googleapis.com/auth/gmail.send` and `https://www.googleapis.com/auth/calendar.events`; Google issues it only when domain wide delegation grants both scopes), then calls `GET https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events?maxResults=1` (`calendarId` percent encoded; it can contain `@` and `#`). This read proves access, not write permission; a calendar the sender can only read passes here and fails at the first mirror write (AC-19), which is why owner setup creates the calendar inside the HOL mailbox. Each call has a 10 second timeout. Results, all field errors with nothing written: `unauthorized_client` from the token call is "Google refused this key for <sender>. In the Google Admin console, add client ID <client_id> under domain wide delegation with the gmail.send and calendar.events scopes." on `keyFile` (`client_id` from the uploaded file); `invalid_grant` or `invalid_client` is "Google didn't accept this key for <sender>. Check that the key still exists in Google Cloud and that <sender> is a user in your Workspace domain." on `keyFile`; a 403 or 404 on the calendar read is "<sender> can't open this calendar. Create it in that mailbox or share it with \"Make changes to events\"." on `calendarId`; a timeout, network error, 429, or 5xx is "Couldn't reach Google to check the key. Try again." The check's result is not audited.
- **AC-3**: The key file is parsed as JSON with the Zod schema `GoogleServiceAccountKey` = `{ type: "service_account", client_id: string of digits, client_email: email ending ".iam.gserviceaccount.com", private_key: string starting "-----BEGIN PRIVATE KEY-----", private_key_id: non empty string }`; other fields (`project_id`, `token_uri`, and so on) are ignored. Any failure, including invalid JSON, is "This isn't a Google service account key file (.json)." on `keyFile`, and the parse error is never logged with its input. Only `JSON.stringify({ clientEmail, privateKey, privateKeyId })` is stored, as the encrypted secret (spec 0006 AC-7, same AAD). `client_id` is used only for the AC-2 message and is not stored. The file is never echoed back; after a failed save the admin picks it again.
- **AC-4**: Editing a `GOOGLE` key: the dialog shows Name, Sender mailbox, Calendar ID, Dev inbox, Ops BCC (read once on open, the Testbed Types pattern), and an empty Key file input ("Leave empty to keep the current key"). With no file, Name, Dev inbox, and Ops BCC changes save with no Google call. A Sender mailbox or Calendar ID change, or a type change to or from `GOOGLE`, without a file is refused on `keyFile`: "Upload the key file again to change the sender, calendar, or type." With a file, AC-2 runs and the save replaces the secret and `secret_updated_at`, plus any changed fields. Audit (same transaction): `api_key.created` metadata adds `senderEmail`, `calendarId`, `devInbox`, `opsBcc` for a `GOOGLE` key; `api_key.updated` lists those four in `changedFields` alongside name, type, base URL; `api_key.secret_replaced` when a file was saved. Deleting a `GOOGLE` key has no blocker; from the worker's next run, emails wait (AC-9).
- **AC-5**: The web process never decrypts the `GOOGLE` secret. The worker reads it only through `googleMailConfig(conn, keyring)` in `server/catalog/api-keys.ts`, which returns `{ clientEmail, privateKey, privateKeyId, senderEmail, calendarId, devInbox, opsBcc, stamp }` (`stamp` = `updated_at` as ISO) or `null` when no live key exists. The private key and any access token never appear in a log line, thrown message, `jobs.last_error`, `email_messages.last_error`, audit metadata, or action result (spec 0006 AC-8 extended); the `secret_ciphertext` source scan still finds the identifier only in `server/catalog/api-keys.ts`.

*Queueing (in the booking transaction)*

- **AC-6**: Every booking change that a learner should hear about queues its notices inside the same transaction as the change, in the three functions every caller already goes through: `confirmGuestBooking` (`provisioning` to `confirmed`: kind `booked`), `rescheduleBooking` (`rescheduled`), and `cancelBooking` (`cancelled`, whatever the source: learner, admin, or deactivation). `confirmGuestBooking` changes its `RETURNING` to include `version` (always 1 there, since `bookings_version_bump` skips `provisioning` to `confirmed`) and returns `Result<{ version: number }, "gone">`. Each function queues, through `queueBookingNotice(trx, bookingId, version, kind)`, in this order: it generates the email id in the app (`crypto.randomUUID()`); inserts one `send_email` job (payload `{ emailMessageId }`, idempotency key `email:<bookingId>:<kind>:<version>`, `ON CONFLICT DO NOTHING RETURNING id`; no row returned means this notice already exists and the function stops); inserts one `email_messages` row with that id and `job_id` (`status = 'queued'`, `booking_version` = the version the change returned, `to_address` = `users.email` now, `subject` per AC-12 or AC-13, `details` = the AC-11 snapshot); then inserts one calendar job (`calendar_upsert` for booked and rescheduled, `calendar_delete` for cancelled, payload `{ bookingId }`, key `calendar:<bookingId>:<version>`). A repeat of the same key inserts nothing. A rolled back change queues nothing. `confirmed` to `completed` and a compensated saga queue nothing. A reschedule always bumps the version, since `rescheduleOwnBooking` already refuses the same start (`same_time`) and any other change moves `starts_at` or `testbed_id`.
- **AC-7**: Google never takes part in the booking transaction. A Google outage, a missing key, or a failed send never refuses, delays, or undoes a booking, reschedule, or cancel; the action's reply is the same as before this feature.

*The job runner (worker)*

- **AC-8**: A new worker step, "jobs", runs after "testbed teardown" each tick. First, an exhausted lease sweep: every handled job that is `running` with `locked_until < now()` and `attempts = 8` (a crash on its last try) is set `failed`. Then it loops: check the budget (stop when 20 jobs have run or 40 seconds have passed, checked **before** each claim so a claimed job is never left to the step timeout), claim one job, run it, record the outcome, until no job is due. A claim is one statement: pick the oldest (`run_at`, then `created_at`) job whose kind is in the handled set, with `attempts < 8` (so the `jobs_attempts_check` cap of 8 is never exceeded), that is either `pending` with `run_at <= now()` or `running` with `locked_until < now()`, `FOR UPDATE SKIP LOCKED`, and set `status = 'running'`, `locked_until = now() + interval '5 minutes'`, `attempts = attempts + 1`. Outcomes: `done` sets `status = 'done'`, `locked_until = null`, `last_error = null`; `retry` sets `status = 'pending'`, `run_at = now() + least(1 minute * 2^(attempts - 1), 1 hour)`, `last_error`; `final`, or a `retry` at `attempts = 8` (a 429 or 5xx on the 8th try included), sets `status = 'failed'` and logs at error level. On **every** path that sets a `send_email` job `failed` (final, attempts used up, the exhausted lease sweep, a missing email row), `finishJob` sets its `email_messages` row to `failed` with the reason in the same transaction, so a dead email never blocks the later ones (AC-10). The handled set is `send_email`, `calendar_upsert`, `calendar_delete`; `send_welcome` jobs are never claimed until feature 16 adds a handler. The daily purge also deletes `done` jobs older than 30 days.
- **AC-9**: At the start of each "jobs" step the worker reads `googleMailConfig`. With no live `GOOGLE` key it claims nothing, logs "jobs: no Google key, email and calendar jobs wait" once per change of state (not every tick), and spends no attempts. A 401 from Gmail or Calendar first drops the cached access token, mints a new one once, and repeats the call once. When Google still rejects the credential (`unauthorized_client`, `invalid_grant`, or `invalid_client` when minting, or a second 401), the breaker trips: that job goes back to `pending` with its attempt given back (`attempts - 1`) and `run_at = now() + 5 minutes`, its `email_messages.last_error` reads "Google rejected the service account key. Check the key and domain wide delegation, and upload a new key on API Keys if needed.", the step stops for this tick, and the error is logged once per tick.
- **AC-10**: A `send_email` job is not claimable while an older email for the same booking (lower `booking_version`, found through `email_messages.job_id` = the job's id) is still `queued`, so a learner's emails for one booking always go out in version order (booked, then rescheduled, then cancelled), each with its own content.

*The emails*

- **AC-11**: The `details` snapshot is parsed by the Zod schema `BookingEmailDetails` and built by one explicit column read (never `os_username` or `os_password`): `learnerName` (`users.name`), `timezone` (`users.timezone`), `labTypeName` (`testbed_types.name` of `bookings.testbed_type_id`), `testbedName`, `startsAt`, `endsAt` (ISO, from the booking row after the change), `appUrl` (`appUrl()` of the process that queued it, so the links match the app the learner used), and `links` (Portal URL, LMS URL, and each client's name, kind, URL in `position` order, the spec 0012 `LabLinks` shape; every URL must parse as `https:`, which the admin forms already enforce with `HttpsUrl`) for booked and rescheduled, `null` for cancelled. It is what the email shows, so each email describes its own version even after the booking moves on.
- **AC-12**: Booked and rescheduled emails follow `context/Nile HOL Lab Access Email Standalone.html`, rebuilt with React Email: the hidden preview line "Your lab is reserved. Access links and session details inside.", the Nile logo, the heading "Your lab access is ready" (booked) or "Your reservation was rescheduled" (rescheduled), the note that links work only from start time until the session ends, the details card (lab type, testbed, start, end), the "Lab access" list (Portal, LMS, one link per client, from `details.links`), the "Set your password" note, a "Manage my reservation" button to `<details.appUrl>/reservations`, the one active reservation rule, and the Nile footer (fixed copy and links taken from the standalone file into the shared `NileFooter`). Subject: `Your Nile Hands-On Lab access - <start>` (booked) or `Updated: Your Nile Hands-On Lab access - <start>` (rescheduled). Links are included whether or not the learner has verified their email.
- **AC-13**: Cancelled emails follow `context/Nile HOL Cancellation Email Standalone.html`: preview line, logo, "Your reservation was cancelled", the note that the testbed is released, the calendar event removed, and the access links no longer work, the details card with lab type, testbed, "Was scheduled" (`startsAt`) and "Until" (`endsAt`), a "Reserve a new lab" button to `<details.appUrl>/book`, and the footer with its nilesecure.com link. Subject: `Cancelled: Your Nile Hands-On Lab reservation - <start>`. It is the learner's only cancellation message.
- **AC-14**: Every time in an email (subject, card, plain text) is `formatEmailDateTime(date, details.timezone)` in `lib/format-time.ts`: `en-US`, `weekday: "short"`, `month: "short"`, `day: "numeric"`, `year: "numeric"`, `hour: "numeric"`, `minute: "2-digit"`, `timeZoneName: "shortGeneric"`, which gives `Tue, Oct 13, 2026, 9:00 AM ET` for `America/New_York` and a generic name such as `Germany Time` elsewhere.
- **AC-15**: Each email is one MIME message (nodemailer `MailComposer`): `From: "Nile Hands-On Labs" <sender_email>`; `To` the routed recipient (AC-16); `Bcc` the Ops BCC when set and the recipient was not rerouted, built with `keepBcc: true` so Gmail sees it (Gmail removes the header on delivery); `multipart/alternative` with the plain text part and the HTML part from React Email's `render` (`plainText: true` for the text); the logo as an inline `cid:nile-logo` PNG attachment (a committed copy of `public/brand/nile-logo.png` resized to 60 px tall, at most 10 KB); the invite both as the `text/calendar; method=REQUEST` or `method=CANCEL` alternative and as an `invite.ics` attachment (MailComposer's `icalEvent`, which does both; Outlook and Apple Mail read the attachment form); and the header `Message-ID: <<email id>@nile-hol-reservations>` so a rare duplicate is visible in Sent. `runSendEmail` is safe to run twice: it locks its `email_messages` row `FOR UPDATE` first, and if the row is gone or no longer `queued` it finishes the job `done` without sending. The raw message is sent with `POST https://gmail.googleapis.com/gmail/v1/users/me/messages/send` (`{ raw }` base64url) with a 10 second timeout. A 2xx parsed with Zod as `{ id: string }` marks the row `sent` with `provider_message_id`, `sent_to`, and `sent_at = now()`. A 429, a 5xx, a timeout, or a network error is `retry`; a 401 trips the AC-9 breaker; any other 4xx is `final` (`failed`, `last_error` = "Gmail refused the message (<status>).").
- **AC-16**: Routing is the pure function `routeEmail(toAddress, { devInbox, opsBcc })` in `lib/email-routing.ts`. A **test address** is one whose local part starts with `dev-` or `hol-test-` (ignoring case), or whose domain ends in `.test`, `.invalid`, `.example`, or `.localhost`, or is `example.com`, `example.net`, or `example.org`. A test address goes to `devInbox` with the subject prefixed `[dev] ` and no Bcc; with no `devInbox` the row is set `suppressed` with `last_error` "Test address and no dev inbox is set." and nothing is sent. Any other address goes to itself, with `opsBcc` as Bcc when set.
- **AC-17**: The invite (`ical-generator`): `METHOD:REQUEST` for booked and rescheduled, `METHOD:CANCEL` and `STATUS:CANCELLED` for cancelled; `UID:<booking id>@nile-hol-reservations` (a constant suffix, so the UID never depends on which process sent it); `SEQUENCE:<booking_version>`; `DTSTAMP` = the email row's `created_at` (fixed, not the send time); `DTSTART`/`DTEND` in UTC from `details`; `ORGANIZER` the sender mailbox with the name "Nile Hands-On Labs"; one `ATTENDEE`, the routed recipient, `PARTSTAT=NEEDS-ACTION`, `RSVP=FALSE`; no `Reply-To`; `SUMMARY:Nile Hands-On Lab: <lab type>`; `DESCRIPTION` the plain text summary with the manage link. Gmail adds an invite to the calendar on its own only from senders it trusts; otherwise the learner clicks Add. Once the event is in the calendar (added automatically or by the learner), the reschedule moves it and the cancel removes it, in Gmail, Outlook, and Apple Calendar (checked in [verify.md](verify.md)).
- **AC-18**: When a `send_email` job runs and its email's `details.endsAt` is at or before the DB clock `now()`, the row is set `suppressed` with `last_error` "The booking had already ended." and nothing is sent; the job is `done`.

*Calendar mirror*

- **AC-19**: `calendar_upsert` and `calendar_delete` both run `syncBookingEvent(bookingId)`, which reads the booking's current row (not the snapshot). A missing booking, or one still `provisioning`, is `done` with no call. Event id = the booking id without dashes (valid Google event id characters, so a rerun targets the same event). Calendar ids in URLs are percent encoded. A `cancelled` booking: `DELETE` the event; 404 and 410 count as done. Otherwise (`confirmed` or `completed`): `PUT` the event (update); on 404, `POST` it with that id (insert); a 409 on that insert (a concurrent run created it) retries the `PUT` once. The event has the summary `<learner name> · <lab type> · <testbed>`, prefixed `[dev] ` when the learner's email is a test address (`isTestAddress`, AC-16), so test bookings stay visible as held testbeds but are clearly marked; UTC start and end, a description with the learner's email and company and the booking id, no attendees, and `sendUpdates=none`. Success sets `bookings.calendar_event_id`. Retry, breaker, and final rules match AC-15. A failed calendar job never affects the email.
- **AC-20**: `npm run calendar:backfill` (a dry run by default, `--apply` to write) queues `calendar_upsert` for every `confirmed` booking with `ends_at > now()`, with key `calendar:<id>:<version>`, and prints the count. It queues no emails. Running it twice queues nothing new.

*Console*

- **AC-21**: The learner detail page (`/admin/users/[id]`) gains an **Emails** section under Bookings: the user's last 50 `email_messages`, newest first, with When (`formatDateTime(created_at, admin timezone)`), Kind (Booked, Rescheduled, Cancelled, Welcome, Reminder), Subject, To (`sent_to` when set, else `to_address`), Status (badge: Queued `info`, Sent `success`, Failed `accent`, Suppressed `neutral`), and the `last_error` line under the status for Failed, Suppressed, or a Queued row that has one. Empty state: "No emails yet." When no live `GOOGLE` key exists, the section shows the note "Email isn't set up yet. Add a Google key on API Keys." The read selects explicit columns and never `details`.

*Worker runtime and proof*

- **AC-22**: The worker renders React Email: `npm run worker` drops `--conditions=react-server` and instead loads `worker/server-only-hook.mjs` with `--import`, a Node resolve hook that maps the `server-only` specifier to that package's `empty.js` and changes nothing else. A test asserts the hook's mapping, and the worker smoke check renders one template. `db:migrate` keeps its flags.
- **AC-23**: Render proof: Vitest snapshots of the rendered HTML, the plain text, and the `.ics` for booked, rescheduled, and cancelled (fixed details, `America/New_York` and `Asia/Kolkata`); and the manual matrix in [verify.md](verify.md) recorded once before `done` (Gmail web, Gmail Android or iOS, Outlook on the web, Outlook desktop, Apple Mail), checking that the layout matches the standalone files and that the invite adds, moves, and removes the event.
- **AC-24**: Migration `0009_google_email.sql` applies the data model below; `db:codegen` regenerates `server/db/types.ts`; `EmailKind` and `EmailStatus` join `lib/db-enums.ts` and `checkLists`, and `ApiKeyType` gains `GOOGLE`, so the parity test covers every new `CHECK` list.

## Decision

**Chosen option**: Option 2: an outbox in the booking transaction, sent by the worker through the Gmail API as one mailbox, using a domain wide delegation service account key held as a `GOOGLE` API key.

Notices are queued in the same transaction as the booking change and sent later by the worker's job runner. Each one is a single MIME message carrying our own `.ics` invite, rendered with React Email, and sent through Gmail by a service account acting as the HOL mailbox, whose JSON key an admin uploads on the API Keys page. The same key mirrors bookings onto a shared calendar. The owner accepted the domain wide reach of this key for now (2026-10-14); Option 1, a per mailbox grant, is the documented upgrade path.

**New dependencies** (pin exact versions at install; check the installed API in `node_modules` before building, as the repo's AGENTS.md asks): `react-email` 6.x (components and `render` both import from `react-email`), `nodemailer` (its `MailComposer` only, plus `@types/nodemailer`), `ical-generator`, `google-auth-library`.

**Implementation skills**: `react-email` (`resend/react-email`, `.claude/skills/react-email/`) · `kysely` (`mindrally/skills`, `.claude/skills/kysely/`) · `supabase-postgres-best-practices` (`supabase/agent-skills`, `.claude/skills/supabase-postgres-best-practices/`) · `zod` (`pproenca/dot-skills`, `.claude/skills/zod/`) · `vitest` (`antfu/skills`, `.claude/skills/vitest/`) · `shadcn` (`shadcn-ui/ui`, `.claude/skills/shadcn/`) · `playwright-best-practices` (`currents-dev/playwright-best-practices-skill`, `.claude/skills/playwright-best-practices/`) · `gws-gmail`, `gws-calendar` (`googleworkspace/cli`, `.claude/skills/gws-gmail/`, `.claude/skills/gws-calendar/`): API reference for the Gmail and Calendar endpoints only; we call them with `fetch`, not the `gws` CLI. Ignore the `react-email` skill's Resend sending sections.

## Rationale

Reasoning and options: see [rationale.md](rationale.md).

## Feature design

### Data model sketch

Migration `0009_google_email.sql` (one migration; constraint names are a contract with `mapConstraintError`).

**api_keys** (existing, widened)

| Column | Type | Null | Rule |
|---|---|---|---|
| type | text | no | `api_keys_type_check` adds `GOOGLE`; `api_keys_one_google_uq` unique on `(type)` where `type = 'GOOGLE' and deleted_at is null` |
| base_url | text | no | `GOOGLE`: always `https://www.googleapis.com` |
| secret_ciphertext | text | no | `GOOGLE`: encrypted `{ clientEmail, privateKey, privateKeyId }` |
| sender_email | text | yes | typed in the form; the mailbox the service account acts as |
| calendar_id | text | yes | the shared "HOL bookings" calendar |
| dev_inbox | text | yes | test addresses go here; null means they are suppressed |
| ops_bcc | text | yes | null means no Bcc |
| | | | `api_keys_google_fields_check`: `(type = 'GOOGLE') = (sender_email is not null and calendar_id is not null)` and, when `type <> 'GOOGLE'`, `dev_inbox is null and ops_bcc is null` |

**email_messages** (new; spec 0002's shape with `sent_to`, `details`, and `suppressed` added)

| Column | Type | Null | Rule |
|---|---|---|---|
| id | uuid | no | PK, `default gen_random_uuid()` |
| user_id | uuid | no | FK `users` `ON DELETE RESTRICT` |
| booking_id | uuid | yes | FK `bookings` `ON DELETE RESTRICT` |
| booking_version | integer | yes | `email_messages_booking_version_together`: `(booking_id is null) = (booking_version is null)` |
| job_id | uuid | yes | FK `jobs` `ON DELETE SET NULL` |
| kind | text | no | `email_messages_kind_check`: `welcome` \| `booked` \| `rescheduled` \| `cancelled` \| `reminder` |
| to_address | text | no | the learner's address when queued |
| sent_to | text | yes | the address it went to (differs only when rerouted) |
| subject | text | no | as sent, before any `[dev] ` prefix |
| details | jsonb | no | parsed per kind: `BookingEmailDetails` (AC-11) for `booked`, `rescheduled`, `cancelled`; feature 16 and 17 define `welcome` (`{}` until then) and `reminder` |
| status | text | no | `email_messages_status_check`: `queued` \| `sent` \| `failed` \| `suppressed`; default `queued` |
| provider_message_id | text | yes | Gmail message id |
| sent_at | timestamptz | yes | |
| last_error | text | yes | fixed app messages only, never a token or a raw Google body |
| created_at, updated_at | timestamptz | no | `set_updated_at()` trigger |

Indexes: `email_messages_one_per_version_uq` unique `(booking_id, kind, booking_version)` where `booking_id is not null` (also serves the AC-10 ordering lookup); `(user_id, created_at desc)` for the console; `(job_id)`. RLS enabled. The spec 0002 welcome unique index is **not** created here (feature 16 decides it; spec 0008's resend makes more than one welcome email per user possible).

**bookings** (existing, unchanged): `calendar_event_id` is now written (AC-19). Its change does not fire `bookings_version_bump`.

**jobs** (existing, unchanged): `send_email`, `calendar_upsert`, `calendar_delete` are already in `jobs_kind_check`.

**Dropped from the spec 0002 target**: `integration_secrets` (never built).

Relationships: users 1:N email_messages · bookings 1:N email_messages (optional) · jobs 1:N email_messages (optional, SET NULL).

### State transitions

- `email_messages.status`: (insert) `queued` → `sent` (Gmail 2xx) · `queued` → `suppressed` (test address with no dev inbox, AC-16; booking already ended, AC-18) · `queued` → `failed` (final 4xx, or 8 attempts used). `sent`, `failed`, `suppressed` are terminal. A breaker or retry leaves it `queued`, with `last_error` set.
- `jobs.status` (spec 0001 shape): `pending` → `running` (claim) → `done` | `pending` (retry, breaker) | `failed`. `running` with an expired lease is claimable again.

### API surface

| Surface | Kind | Key inputs | Key outputs | Auth | Key errors |
|---|---|---|---|---|---|
| `createApiKeyAction` | Server Action (widened) | `FormData`: name, type; for `GOOGLE`: `keyFile` (File), `senderEmail`, `calendarId`, `devInbox`, `opsBcc` | `{ kind: "saved", message }` | admin | field errors, `duplicate_name`, `google_exists`, `google_invalid`, `google_delegation`, `google_calendar`, `google_unavailable`, not configured |
| `updateApiKeyAction` | Server Action, `bind(null, id)` (widened) | as above; `keyFile` optional | same | admin | as above, `google_file_required`, `not_found` |
| `/admin/users/[id]` | page (widened) | id | adds `emails: EmailRow[]`, `googleConfigured: boolean` | admin | not authorized |
| `npm run calendar:backfill` | script | `--apply` | count | owner shell | none |
| worker "jobs" step | worker | none | job outcomes | worker | logged |

Domain functions (each returns a typed `Result`; Google calls take an injected `fetch` and token source so tests use fakes):
- `server/catalog/api-keys.ts`: `createApiKey`/`updateApiKey` widened with `GoogleCheckError = "google_invalid" | "google_delegation" | "google_calendar" | "google_unavailable"` and `google_exists`, `google_file_required`; `ApiKeyDeps` gains `verifyGoogle`; `googleMailConfig(conn, keyring): Promise<GoogleMailConfig | null>`; `googleConfigured(conn): Promise<boolean>` (no decrypt).
- `server/google/token.ts`: `googleAccessToken(cfg)` via `JWT` with `subject` = `senderEmail` (a lazy cache keyed by `stamp`, so one client and its token live while the key is unchanged): `Result<string, "rejected" | "unavailable">`.
- `server/google/verify.ts`: `verifyGoogleKey(input)`: `Result<void, "invalid" | "delegation" | "calendar" | "unavailable">`.
- `server/google/gmail.ts`: `sendRaw(token, raw)`: `Result<{ id }, GoogleCallError>`; `server/google/calendar.ts`: `putEvent`, `insertEvent`, `deleteEvent`. `GoogleCallError = "rejected" | "retry" | { kind: "final"; status: number }`.
- `server/email/templates/`: `LabAccessEmail`, `CancellationEmail`, shared `EmailFrame`, `DetailsCard`, `NileFooter` (`.tsx`); `server/email/compose.ts`: `composeBookingEmail(details, kind, route, sender)`: `{ subject, raw }`.
- `lib/email-routing.ts` (`routeEmail`, `isTestAddress`), `lib/booking-email.ts` (`BookingEmailDetails`, `GoogleServiceAccountKey` schemas, `emailSubject(kind, details)`, the `.ics` field builder), `lib/format-time.ts` (`formatEmailDateTime`): pure.
- `server/jobs/booking-notice.ts`: `queueBookingNotice(trx, bookingId, version, kind)`, `runSendEmail`; `server/jobs/calendar-sync.ts`: `syncBookingEvent`; `server/jobs/runner.ts`: `claimJob`, `finishJob`, `runJobs` (the step); `server/email/messages.ts`: `listUserEmails(conn, userId)`.

### Value sourcing

| Action | Value produced / displayed | Source |
|---|---|---|
| Save GOOGLE key | client email, private key, key id (stored); client id (message only) | the uploaded file, parsed by `GoogleServiceAccountKey` |
| Save GOOGLE key | sender, calendar id, dev inbox, ops BCC | form fields |
| Save GOOGLE key | `base_url` | constant `GOOGLE_BASE_URL` |
| Save GOOGLE key | check result | `verifyGoogleKey` on the typed values only (web never decrypts) |
| Queue notice | kind | which function ran: `confirmGuestBooking` → booked, `rescheduleBooking` → rescheduled, `cancelBooking` → cancelled |
| Queue notice | `booking_version` | the `version` the change's `RETURNING` gave (post trigger) |
| Queue notice | `to_address`, learner name, timezone | `users.email`, `users.name`, `users.timezone` of `bookings.user_id`, read in the transaction |
| Queue notice | lab type, testbed, start, end, links | `testbed_types.name` (by `bookings.testbed_type_id`), `testbeds.name`, `bookings.starts_at`/`ends_at`, `testbeds.portal_url`/`lms_url` and `testbed_clients` (name, kind, url, `position`), explicit columns |
| Queue notice | subject | `emailSubject(kind, details)` with `formatEmailDateTime(startsAt, timezone)` |
| Send | From address, ICS organizer | `api_keys.sender_email` via `googleMailConfig` |
| Send | recipient, Bcc, `[dev] ` prefix, suppression | `routeEmail(to_address, { devInbox, opsBcc })` from `googleMailConfig` |
| Send | access token | `googleAccessToken` from the decrypted key, acting as `sender_email` |
| Queue notice | `appUrl` (manage and reserve URLs) | `appUrl()` in `server/env.ts` of the queuing process, stored in `details` |
| Queue notice | email id, `job_id` | `crypto.randomUUID()` in `queueBookingNotice`; the `send_email` job's returned id |
| Send | ICS `UID` | `<booking id>@nile-hol-reservations` (constant suffix) |
| Send | ICS `DTSTAMP` | `email_messages.created_at` |
| Send | `Message-ID` | `<email_messages.id@nile-hol-reservations>` |
| Send | ICS `SEQUENCE` | `email_messages.booking_version` |
| Send | stale check clock | DB `now()` (`dbNow`) |
| Send | logo | `server/email/assets/nile-logo-email.png`, read once (lazy cache) |
| Send | `provider_message_id` | Gmail reply `id` |
| Calendar sync | event fields | the booking's current row joined to users, testbeds, testbed_types; calendar from `googleMailConfig.calendarId` |
| Calendar sync | `[dev] ` summary prefix | `isTestAddress(users.email)` |
| Calendar sync | event id | booking id without dashes |
| Console | When | `formatDateTime(email_messages.created_at, admin timezone)` (server/users/AGENTS.md admin timezone) |
| Console | Kind, Status labels and tones | `email_messages.kind`/`status` through fixed label maps and `toneFor` |
| Console | "Email isn't set up yet" note | `googleConfigured(conn)` |
| Runner | backoff, lease, attempt cap | constants in `server/jobs/runner.ts`: 1 minute base doubling to 1 hour, 5 minute lease, 8 attempts |

### Key invariants

- A notice is queued if and only if its booking change commits (same transaction, AC-6); Google is never called inside a booking transaction (AC-7).
- One `email_messages` row and one job per (booking, kind, version) (unique index plus idempotency keys).
- No `send_email` job ends `failed` while its email row is still `queued` (AC-8).
- No job is claimed at `attempts = 8`; `jobs_attempts_check` is never violated.
- A booking's emails leave in version order (AC-10).
- Only the worker decrypts the `GOOGLE` secret, only through `googleMailConfig` (AC-5). `secret_ciphertext` stays confined to `server/catalog/api-keys.ts`; `os_password` stays confined to `server/catalog/testbeds.ts` (the snapshot read names its columns).
- `last_error` columns hold only fixed app messages and HTTP status numbers, never Google's response body (it can echo request data).
- A test address never reaches a real recipient (AC-16).
- The breaker and the no key wait never spend attempts (AC-9).

### Security model

- Admins only manage the `GOOGLE` key (`requireAdmin()` on the page and both actions, as in spec 0006 AC-10). The key file is accepted once in a Server Action POST, parsed, encrypted, and dropped; it is never echoed back, and a failed save does not return it (the admin picks the file again).
- The credential is a service account key with domain wide delegation limited to `gmail.send` and `calendar.events`. **Accepted risk (owner, 2026-10-14):** a stolen DB plus keyring could send mail as, and edit the calendars of, any user in the Workspace domain until the key is deleted in Google Cloud. Mitigations: those two scopes only in the delegation entry; the key decrypted only in the worker; rotate it yearly (create a new key, upload it, delete the old one in Google Cloud); optionally set the org policy `iam.serviceAccountKeyExpiryHours` so keys expire on their own. Workspace audit logs show the service account's client ID on every action it takes. The per mailbox grant (rationale Option 1) removes this risk if it is ever needed.
- The worker holds the keyring (already true since spec 0012). The web process holds it to encrypt and never decrypts.
- The email carries lab links to the learner's own mailbox; the links still require an Authentik sign in inside the booking window (spec 0012). The Ops BCC mailbox receives the same links and should be a restricted internal mailbox.
- Test addresses are rerouted or suppressed, so dev and Playwright never mail outside parties.
- Key changes are audited (spec 0006 actions); sends are recorded in `email_messages`, not the audit log. No compliance scope; email addresses and names are PII already held in `users`.

### Configuration required

- No new env vars. The worker needs no `APP_URL`: links come from the snapshot, and the ICS UID suffix is a constant.
- The spec 0001 vars `GOOGLE_MAIL_DRIVER`, `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET_FILE`, `GOOGLE_SERVICE_ACCOUNT_FILE`, `GOOGLE_SENDER`, `GOOGLE_SHARED_CALENDAR_ID`, and `HOL_OPS_BCC` are **not** created.
- Owner setup (once):
  1. In a Google Cloud project: enable the Gmail API and Google Calendar API; create a service account; on its **Keys** tab, *Add key* → *Create new key* → **JSON** (the browser downloads it once; Google keeps no copy). If key creation is blocked, an org admin must allow it for this project (`iam.disableServiceAccountKeyCreation`). Note the service account's client ID.
  2. In the Google Admin console (super admin): Security → API controls → **Domain wide delegation** → add that client ID with exactly `https://www.googleapis.com/auth/gmail.send,https://www.googleapis.com/auth/calendar.events`.
  3. In the HOL mailbox's Google Calendar, create the "HOL bookings" calendar and share it read only with the admins; copy its Calendar ID from its settings. The HOL mailbox must be a real Workspace user.
  4. On `/admin/api-keys`, add a `GOOGLE` key with the JSON file, the HOL mailbox as Sender mailbox, the Calendar ID, a dev inbox you own, and the Ops BCC; then delete the downloaded file (a new key can always be created).
  5. Run `npm run calendar:backfill -- --apply` once.
  6. Check that the HOL mailbox's domain has SPF and DKIM set up (Workspace default DKIM must be turned on).

### Critical test scenarios

- Happy path: a guest books; the row is `queued` in the same transaction; the worker sends one message whose MIME has the HTML, text, `cid:nile-logo`, and a `METHOD:REQUEST` invite with `SEQUENCE` = version; the row is `sent` with the Gmail id; the calendar event exists. Verifies **AC-6**, **AC-8**, **AC-12**, **AC-15**, **AC-17**, **AC-19**
- Order: book, reschedule, and cancel inside one minute queue three emails; the runner sends them in version order even when the later jobs are due first. Verifies **AC-10**, **AC-13**
- Rollback: a reschedule that loses its slot (`slot_taken`) queues nothing; a compensated guest saga queues nothing. Verifies **AC-6**
- Google down: with the fake Gmail returning 503, a cancel still succeeds; the job backs off 1, 2, 4 minutes and ends `failed` after 8 with its email row `failed`, and the next email for that booking then sends; the booking is untouched. Verifies **AC-7**, **AC-8**, **AC-10**
- Crash safety: a `running` job at 8 attempts with an expired lease is failed by the sweep (no constraint error) and its email row is `failed`; a job whose email row is already `sent` finishes `done` without a second send. Verifies **AC-8**, **AC-15**
- No key and breaker: no `GOOGLE` key means nothing is claimed and attempts stay 0; one 401 mints a new token and the retry succeeds; `invalid_grant` puts the job back with its attempt returned and the fixed message. Verifies **AC-9**
- Stale: an email whose `endsAt` has passed is `suppressed`, not sent. Verifies **AC-18**
- Routing: `dev-a@x.com`, `hol-test-learner@example.test`, `a@b.invalid` go to the dev inbox with `[dev] ` and no Bcc, or are suppressed with no dev inbox; `priya@acme.com` goes to itself with the Bcc. Verifies **AC-16**
- Times: `formatEmailDateTime` gives the exact template strings for New York and a generic name for Kolkata. Verifies **AC-14**
- Key save: a file that isn't JSON, an OAuth client JSON instead of a service account key, `unauthorized_client` (no delegation), `invalid_grant`, a 404 calendar, and a timeout each give their message and write nothing; a valid file stores only the three fields as ciphertext; a sender or calendar change without a file is refused; a dev inbox change makes no Google call. Verifies **AC-1**, **AC-2**, **AC-3**, **AC-4**
- Leak proof: the Playwright canary scan (spec 0006) extended to a `GOOGLE` key's private key; forced token errors put no token in `last_error` or logs; source scans pass. Verifies **AC-5**
- Calendar: upsert twice gives one event; upsert after a cancel deletes; delete of a missing event is done; a 409 on insert falls back to update; a `dev-` learner's event has the `[dev] ` prefix; backfill run twice queues nothing new. Verifies **AC-19**, **AC-20**
- Console: a learner with sent, failed, and suppressed rows shows them newest first with tones and errors; a learner with none shows the empty state; the not set up note shows with no key; a learner calling the page is refused. Verifies **AC-21**
- Worker runtime: the hook maps `server-only`; the worker renders a template under `npm run worker`. Verifies **AC-22**
- Render: snapshots, plus the manual matrix in verify.md. Verifies **AC-23**
- Schema: parity test passes with the new enums. Verifies **AC-24**

## Build plan

Tracer Bullet: the first two tasks prove one booked email from a real booking to a real inbox through every layer; the rest thicken it.

1. [x] Foundations: `worker/server-only-hook.mjs` and the `worker` script change, with its test; migration `0009_google_email.sql`, `db:codegen`, the enums in `lib/db-enums.ts` and `checkLists`, `mapConstraintError` for `api_keys_one_google_uq`; the `GOOGLE` type on create only (file field, sender field, `GoogleServiceAccountKey`, `verifyGoogleKey`, the field errors, the badge and sender cell); `googleMailConfig` and `googleConfigured`. Satisfies **AC-1**, **AC-2**, **AC-3**, **AC-5**, **AC-22**, **AC-24**
2. [x] Tracer thread, booked: `BookingEmailDetails`, `queueBookingNotice` called from `confirmGuestBooking`; the runner (`claimJob`, `finishJob`, `runJobs`, backoff, attempt cap, the handled set, the step in `worker/index.ts`); `formatEmailDateTime`; `routeEmail`; the React Email `LabAccessEmail` with its shared parts and the resized logo; the `.ics`; `composeBookingEmail`; `googleAccessToken` and `sendRaw`; `runSendEmail`. Book as a `dev-` learner and see it arrive in the dev inbox. Satisfies **AC-6**, **AC-7**, **AC-8**, **AC-11**, **AC-12**, **AC-14**, **AC-15**, **AC-16**, **AC-17**
3. [x] Reschedule and cancel: `queueBookingNotice` in `rescheduleBooking` and `cancelBooking`; the rescheduled heading and subject; `CancellationEmail`; `METHOD:CANCEL`; the version order claim rule. Satisfies **AC-6**, **AC-10**, **AC-12**, **AC-13**, **AC-17**
4. [x] Failure strands: the no key wait with its one time log, the breaker with the attempt returned, the stale skip, the final 4xx mapping, the daily purge of old `done` jobs. Satisfies **AC-7**, **AC-8**, **AC-9**, **AC-18**
5. Calendar mirror: `putEvent`, `insertEvent`, `deleteEvent`, `syncBookingEvent`, `calendar_event_id`; `npm run calendar:backfill`. Satisfies **AC-19**, **AC-20**
6. [x] Key edit: the `GOOGLE` edit dialog, the file required rules, the widened audit metadata and `changedFields` keys. Satisfies **AC-4**
7. Console: `listUserEmails`, the Emails section, the not set up note. Satisfies **AC-21**
8. Proof: template snapshots, the extended canary scan and source scans, Vitest DB tests in `inRollback` with fake Google calls, Playwright for the key and the Emails section, and the manual matrix in `verify.md`. Satisfies **AC-5**, **AC-23**

## Migration plan

**Strategy**: switched on by data. Migration `0009` is additive. Until a `GOOGLE` key exists, notices queue and wait and nothing is sent (AC-9), so the code can ship before the owner setup.
**Phases**:
1. Deploy the code and run `npm run db:migrate`; restart the worker so it picks up the new script flags.
2. Owner setup with a `dev-` dev inbox; book, reschedule, and cancel as a `dev-` learner; run the verify.md matrix.
3. Run `npm run calendar:backfill -- --apply`. Real learner emails start with their next booking change.
**Rollback**: delete the `GOOGLE` key (sending stops at the next tick, notices keep queueing), or revert the commit; `0009` needs no down step because the old code ignores the new columns and table.
**Risks**: notices queued before the key exists send late when it is added, minus any whose booking has ended (AC-18). Before phase 2, check that the queued backlog is what you expect. A wrong Ops BCC leaks lab links to that mailbox, so check it on save.

## Consequences

**Positive**:
- One send path for dev and prod (they share a worker), with no Google env vars and no restart to change settings.
- No human sign in: nothing stops working when a password changes, and the HOL address only has to be a real user, not someone's login.
- Bookings never wait on Google; the outbox gives retries and a visible history for free.
- The runner, templates, routing, and Gmail client are what features 16 (welcome) and 17 (reminder) need; each adds a handler and a template.
- Every email lands in the HOL mailbox's Sent folder, a second record beside `email_messages`.

**Negative / tradeoffs**:
- Mail goes out on the worker's tick, so it lands about 30 to 90 seconds after the action, not instantly.
- If the worker crashes after Gmail accepts a message but before the row is marked, the retry sends a duplicate; Gmail has no idempotency key. Rare, and accepted.
- A leaked key plus keyring reaches every user in the domain for `gmail.send` and `calendar.events`, until someone deletes the key in Google Cloud. Accepted by the owner for now.
- The key never expires on its own; rotation is a manual yearly chore unless an expiry policy is set.
- Setup needs a Workspace super admin (delegation) and possibly an org policy exception for key creation.
- Changing the sender or calendar needs the key file again, because the web process never decrypts.
- Version ordering means one stuck email (backing off for up to about 2 hours) holds back the later emails for that booking.
- Gmail's Workspace limit (about 2,000 messages a day per mailbox) caps volume; far above today's needs.
- The worker no longer runs with the React Server Components condition; any future worker code must not rely on it.

**Neutral**:
- `email_messages` keeps rows indefinitely (small); old `done` jobs are purged after 30 days.
- The service account, its delegation entry, and the HOL mailbox become owner managed assets, like the keyring.

## Follow-up

- [ ] Owner: the setup steps in *Configuration required*, before task 2 can send for real.
- [x] Spec amendments on confirmation (done 2026-10-14): spec 0001 (email, calendar, secrets rows and the env list), spec 0002 (`integration_secrets` dropped, `api_keys` columns, `email_messages` as built), spec 0006 (the `GOOGLE` type, `decryptSecret`'s second caller).
- [ ] Feature 16: decide the welcome email's uniqueness (spec 0002's one per user index conflicts with spec 0008's resend), add its handler to the runner's handled set, and reuse `EmailFrame`.
- [ ] Feature 17: queue the reminder from `queueBookingNotice`'s neighbors with key `reminder:<booking id>:<version>`; AC-10 ordering already covers it.
- [ ] `react-email`, `gws-gmail`, `gws-calendar` are installed but not in AGENTS.md: their conventions belong in a new `server/email/AGENTS.md` (email area), with a one line pointer in root, not root `## Rules`.
- [ ] AGENTS.md: record MCP servers for Gmail and Calendar as skipped for this feature.
- [ ] Revisit the per mailbox grant (rationale Option 1) to remove the domain wide reach; enrolled on the scope's Deferred list.
- [ ] Consider an alert (an email to the Ops BCC or a console banner) when the breaker has been tripped for over an hour.
