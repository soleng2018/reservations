# 0013. Email delivery and booking confirmations: rationale

## Context

> ⚠️ Premise note: spec 0001 split Google sending into a dev OAuth driver and a prod service account driver, chosen by env. Dev and prod now share one database and one worker (owner decision 2026-10-05), so there is only ever one sender, and the split buys nothing but two code paths. Separately, spec 0001's prod pick, a service account with domain wide delegation, can act as **every** user in the Workspace domain; Google offers no way to limit delegation to one mailbox. This spec replaces both with one per mailbox OAuth grant, after the owner weighed that blast radius.

Learners need a confirmation they can trust for every booking change, and their own calendar has to follow the booking: added on book, moved on reschedule, removed on cancel. The scope fixes the content (two standalone HTML templates, exact subjects) and the shape: one message per change that is both the email and the invite, never a separate invite plus email.

Forces:
- **Bookings must not depend on Google.** The booking, reschedule, and cancel paths are lock first transactions with careful refusal handling (specs 0004, 0011). An external call inside them would hold row locks across the network and turn a Google outage into failed bookings.
- **Credentials live in the app.** The owner wants Google credentials managed on the API Keys screen, like the Cloudflare token (spec 0012), not in env files. Spec 0006's rule is that only the worker ever decrypts a stored secret.
- **One shared database for dev and prod.** Dev and Playwright create real bookings for `dev-` and `hol-test-` addresses, and the one worker that sends is production's.
- **The worker runs under `--conditions=react-server`** only so `import "server-only"` passes; that condition makes `react-dom/server` throw (checked 2026-10-14), so nothing React can render there today.
- **Order matters for invites.** Calendar clients apply invites by `UID` and `SEQUENCE`; an update or cancel processed before the original request leaves stray events in some clients.

## Options considered

### Option 1: outbox in the booking transaction, worker sends via Gmail with a per mailbox OAuth token (chosen)

The booking transaction inserts an `email_messages` row (with a snapshot of what to say) and jobs; the worker's job runner renders with React Email, builds MIME with our own `.ics`, and sends through the Gmail API with a refresh token for the HOL mailbox, stored as a `GOOGLE` API key.

**Pros**: bookings never wait on or fail because of Google · retries, ordering, and history come from rows already designed (spec 0001 `jobs`, spec 0002 `email_messages`) · a leak reaches one mailbox · one path for dev and prod.
**Cons**: email arrives on the worker's tick (about 30 to 90 seconds) · a one time consent script, and a reconnect if the grant is revoked · a crash between send and mark can duplicate one email.

### Option 2: outbox, sent with a domain wide delegation service account

Same outbox; the credential is a service account JSON key acting as the HOL mailbox.

**Pros**: no consent step; nothing expires or is revoked by a password change · the key file comes straight from Google Cloud.
**Cons**: the key can act as any user in the domain for its scopes · needs Workspace super admin to grant delegation · many organizations block service account key creation by default.

### Option 3: send inline from the Server Action after commit

The action commits the booking, then calls Gmail before replying.

**Pros**: instant email · no runner to build.
**Cons**: a slow or failing Gmail makes the learner's reply slow or ambiguous · no retry when the process dies after commit, so emails are silently lost · the web process would need to decrypt the credential, breaking spec 0006's rule.

### Option 4: Google Calendar API invites (attendees with `sendUpdates=all`)

Create the event on the HOL calendar with the learner as attendee and let Google send the invite.

**Pros**: Google handles invite formatting and updates · no `.ics` to build.
**Cons**: Google sends its own invitation email, so the learner gets two messages and the Nile template is not the invite body (the scope forbids both) · invite content and subject are Google's, not ours.

## Rationale

The booking paths are the product's core and are already tuned for locks and refusals, so the only acceptable coupling to Google is a row written in the same transaction (Option 1 or 2). Option 3 fails the scope's "a failed send never undoes the booking change" in spirit, since a crash after commit loses mail with no trace, and it would put a usable credential in the web process. Option 4 fails the scope's one message rule outright.

Between 1 and 2 the deciding force is blast radius. Both store the credential encrypted and decrypt it only in the worker, so the realistic threat is a stolen database plus keyring. Under Option 2 that yields mail sending as anyone in the domain; under Option 1 it yields one mailbox whose Sent folder records everything. The cost of Option 1 is a consent script run once and again only after a password reset or revoke, which the worker detects and reports in the console. The owner first chose the service account on my recommendation, then switched to Option 1 once the domain wide reach was spelled out.

Smaller calls made while writing:
- **Snapshot at queue time** (`details` jsonb) rather than reading the booking at send time: with every email sent in order, each must describe its own version; reading live data would make a delayed "booked" email show the rescheduled time. Runner up: store only ids and rebuild from audit history, which is far more complex.
- **Claim one job at a time** with a 20 job and 40 second budget per tick, rather than batch claims: it keeps the per booking ordering rule a single `NOT EXISTS` and fits the worker's 60 second step timeout. Runner up: a batch claim with in memory ordering.
- **Give the attempt back on a breaker trip**: a revoked grant is a configuration problem, not a property of the message, so it should not push messages toward `failed`. Runner up: let them burn attempts, which would fail the whole queue within hours of a password reset.
- **Calendar sync reads the current booking**, unlike email: the mirror only needs the latest truth, and reading it makes any job order converge. Event id from the booking id makes every write idempotent without a stored id.
- **Test address rule includes reserved test domains** (`.test`, `.invalid`, `.example`, `.localhost`, `example.*`) and `hol-test-` because Playwright's learners use `hol-test-learner@example.test`, which the `dev-` prefix alone would miss.
- **Inline logo (CID)** over a hosted URL: Outlook and others hide remote images by default, and dev links would point at a LAN IP.
- **`google-auth-library` plus `fetch`** over the generated `@googleapis/*` clients: four endpoints, Zod parsed replies, and the same shape as `server/cloudflare/access.ts`.
- **Swap the worker's flag for a resolve hook** over typed HTML strings: React Email gives shared components that features 16 and 17 reuse, and the worker is not a React Server Components environment, so normal React is the correct build there.
- **No email audit rows**: `email_messages` is the per send record; the audit log stays for human and system actions.
