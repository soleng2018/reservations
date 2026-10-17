# 0013. Email delivery and booking confirmations: rationale

## Context

> ⚠️ Premise note: spec 0001 split Google sending into a dev OAuth driver and a prod service account driver, chosen by env. Dev and prod now share one database and one worker (owner decision 2026-10-05), so there is only ever one sender, and the split buys nothing but two code paths. So this spec keeps one driver: spec 0001's prod pick, a service account with domain wide delegation. That key can act as **every** user in the Workspace domain (Google offers no way to limit delegation to one mailbox). The owner weighed this against a per mailbox grant and chose the service account for now (2026-10-14); the risk is recorded as accepted in the spec's Security model.

Learners need a confirmation they can trust for every booking change, and their own calendar has to follow the booking: added on book, moved on reschedule, removed on cancel. The scope fixes the content (two standalone HTML templates, exact subjects) and the shape: one message per change that is both the email and the invite, never a separate invite plus email.

Forces:
- **Bookings must not depend on Google.** The booking, reschedule, and cancel paths are lock first transactions with careful refusal handling (specs 0004, 0011). An external call inside them would hold row locks across the network and turn a Google outage into failed bookings.
- **Credentials live in the app.** The owner wants Google credentials managed on the API Keys screen, like the Cloudflare token (spec 0012), not in env files. Spec 0006's rule is that only the worker ever decrypts a stored secret.
- **One shared database for dev and prod.** Dev and Playwright create real bookings for `dev-` and `hol-test-` addresses, and the one worker that sends is production's.
- **The worker runs under `--conditions=react-server`** only so `import "server-only"` passes; that condition makes `react-dom/server` throw (checked 2026-10-14), so nothing React can render there today.
- **Order matters for invites.** Calendar clients apply invites by `UID` and `SEQUENCE`; an update or cancel processed before the original request leaves stray events in some clients.

## Options considered

### Option 1: outbox in the booking transaction, worker sends via Gmail with a per mailbox OAuth token

The booking transaction inserts an `email_messages` row (with a snapshot of what to say) and jobs; the worker's job runner renders with React Email, builds MIME with our own `.ics`, and sends through the Gmail API with a refresh token for the HOL mailbox, stored as a `GOOGLE` API key.

**Pros**: bookings never wait on or fail because of Google · retries, ordering, and history come from rows already designed (spec 0001 `jobs`, spec 0002 `email_messages`) · a leak reaches one mailbox · one path for dev and prod.
**Cons**: email arrives on the worker's tick (about 30 to 90 seconds) · a one time consent script, and a reconnect if the grant is revoked · a crash between send and mark can duplicate one email.

### Option 2: outbox, sent with a domain wide delegation service account (chosen)

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

Between 1 and 2 the trade is blast radius against operational simplicity. Both store the credential encrypted and decrypt it only in the worker, so the realistic threat is a stolen database plus keyring. Under Option 2 that yields mail sending as anyone in the domain; under Option 1 it yields one mailbox. Option 1 costs a consent step and a reconnect after any password reset or revoke, and needs the HOL address to be a real user someone signs into. My recommendation was Option 1. The owner chose Option 2 for now, knowing the domain wide reach: nothing breaks on a password change and no one has to sign in as the HOL mailbox. The two scopes in the delegation entry, worker only decryption, and yearly rotation reduce the risk; Option 1 stays the documented upgrade path (on the scope's Deferred list).

Smaller calls made while writing:
- **Snapshot at queue time** (`details` jsonb) rather than reading the booking at send time: with every email sent in order, each must describe its own version; reading live data would make a delayed "booked" email show the rescheduled time. Runner up: store only ids and rebuild from audit history, which is far more complex.
- **Claim one job at a time** with a 20 job and 40 second budget per tick, rather than batch claims: it keeps the per booking ordering rule a single `NOT EXISTS` and fits the worker's 60 second step timeout. Runner up: a batch claim with in memory ordering.
- **Give the attempt back on a breaker trip**: a revoked grant is a configuration problem, not a property of the message, so it should not push messages toward `failed`. Runner up: let them burn attempts, which would fail the whole queue within hours of a password reset.
- **Calendar sync reads the current booking**, unlike email: the mirror only needs the latest truth, and reading it makes any job order converge. Event id from the booking id makes every write idempotent without a stored id.
- **Test address rule includes reserved test domains** (`.test`, `.invalid`, `.example`, `.localhost`, `example.*`) and `hol-test-` because Playwright's learners use `hol-test-learner@example.test`, which the `dev-` prefix alone would miss.
- **Inline logo (CID)** over a hosted URL: Outlook and others hide remote images by default, and dev links would point at a LAN IP.
- **The sender is typed, not taken from the key**: a service account key carries the robot's own address, not the mailbox it acts as, so the admin names the HOL mailbox; the save check proves delegation works for exactly that mailbox.
- **`google-auth-library` plus `fetch`** over the generated `@googleapis/*` clients: four endpoints, Zod parsed replies, and the same shape as `server/cloudflare/access.ts`.
- **Swap the worker's flag for a resolve hook** over typed HTML strings: React Email gives shared components that features 16 and 17 reuse, and the worker is not a React Server Components environment, so normal React is the correct build there.
- **No email audit rows**: `email_messages` is the per send record; the audit log stays for human and system actions.

## Amendment 2026-10-16: a second sign in method

### Context

The testing sender is a personal Gmail (mnisdm@gmail.com). Saving the service account key failed with `unauthorized_client`, and the fix in the AC-2 message (add the client ID under domain wide delegation in the Google Admin console) can't be done: a gmail.com account has no Admin console, and domain wide delegation exists only inside a Google Workspace domain. A gmail.com account can own a Google Cloud project and create service accounts, but a service account is its own robot identity with no mailbox. It can send as a real user only by acting as that user (the `subject` in `server/google/token.ts`), and only delegation allows that. It could still write a calendar shared with it ("Make changes to events"), since AC-19 adds no attendees, but email would still need another way in. The owner wants to test now with the Gmail, and move to a Workspace sender with the service account in production, working with the Workspace admin.

Forces added:
- **Dev is plain http on a LAN IP** (`http://10.1.255.18:3000`, because the Authentik proxy refuses requests that mention localhost). Google's redirect rules for OAuth accept only https, or localhost and loopback IPs; never a raw IP. So Google cannot send the browser back to the dev app.
- **No public https hostname exists yet**; prod's Cloudflare Tunnel hostname comes with the spec 0001 image and compose work.
- **One shared database and one worker**, so only one Google credential is ever live, whichever process saved it.
- **Spec 0013's rule that the web never decrypts a stored secret** should hold.

### Options considered

1. **Add Google sign in beside the service account, one method per key (chosen).** The sender account consents once, and the app stores its refresh token. **Pros**: works with a gmail.com sender today · reaches one mailbox, not a domain · reuses the outbox, worker, and breaker unchanged · production switches by editing the key. **Cons**: a sign in that dies on a password change, a revoke, about 6 months without use, or 7 days in Testing · a second token path to test · a clumsy return step in dev.
2. **SMTP with an app password.** **Pros**: simplest; nodemailer already builds the MIME. **Cons**: a password that unlocks the whole account, not one scope · needs two step verification · Google keeps retiring older sign in methods · no Calendar access, so the mirror would still need a service account shared calendar · a second send path beside the Gmail API.
3. **Service account for the calendar only, plus another way to send.** **Pros**: no consent step for the calendar. **Cons**: still needs option 1 or 2 for email, so it adds a credential without removing one.
4. **A transactional provider (Resend, Postmark, SES).** **Pros**: better delivery, real sending limits. **Cons**: needs a domain you own (mail sent "from" gmail.com through them fails the receiving server's DMARC check, which tests that the sender really is Gmail), so it doesn't help a gmail.com sender, and it leaves the calendar unsolved.
5. **Wait for the Workspace sender.** **Pros**: no new code. **Cons**: email stays untested until the Workspace admin acts, which the owner doesn't want.
6. **Option 1, but signed in from a script** (`npm run google:sign-in` prints a secret file that is uploaded like the service account key). **Pros**: no cookie, no pasted address, and far less dialog code. **Cons**: the owner asked for a button in the UI; reconnecting after a dead sign in needs a shell on the host; and the printed file holds a refresh token in plain text on disk until someone deletes it. Set aside on the owner's request, but it remains the simpler fallback if the dialog flow proves fragile.

How the sign in comes back to the app, given the http LAN IP:
- **Paste the `127.0.0.1` address (chosen).** Google redirects the browser to a loopback address that doesn't load; the admin copies it into the dialog, and a Server Action behind `requireAdmin()` redeems it. Works from any machine, needs no hostname, and has no public route. Clumsy, but done rarely.
- **A public https dev hostname through the Cloudflare Tunnel.** One real click, but it means new infra now. If `APP_URL` moves to it, the Authentik redirect URIs change (an owner approved setup run), and if it doesn't, the callback lands on another origin without the admin's cookie, so a public route would have to trust a stored state alone.
- **A localhost callback.** Works only when the browser runs on this same machine, and the admin session cookie lives on the LAN IP origin, so it has the same cross origin problem.

### Rationale

Option 1 was already this spec's recommendation (Option 1 in the original record) and the documented upgrade path. The gmail.com sender now makes it necessary, not optional. Keeping the service account beside it, on one key with one method at a time, serves the owner's plan exactly (sign in for testing, service account for production) and keeps every invariant built so far: one live key, worker only decryption of stored secrets, the breaker, and the outbox. The other options either can't serve a gmail.com sender (4), add a weaker, wider credential and a second send path (2), or add a credential without removing one (3).

Decisions made with the owner (2026-10-16): the paste return path; the client file uploaded in the dialog and stored encrypted with the refresh token (not env files, which 0013 removed); one key, switched by editing; both methods always shown, Google sign in labeled for testing (a shared database makes hiding it by env leave keys one side can't edit); a **Desktop app** client only (made for loopback returns, with no redirect URIs to register); reconnecting needs the client file again (keeps the web from decrypting stored secrets); a "Needs attention" badge on API Keys; both scopes or nothing; the sender taken from the signed in account; Service account selected first.

Decided while writing (each with the runner up):
- **The sign in in progress lives in an encrypted cookie**, not a table: it lasts 10 minutes, belongs to one admin's browser, and needs no sweeper. Runner up: a `google_sign_ins` table, inspectable but one more thing to clean up.
- **The start action is called from the button's click handler**, not as a form submit, so the dialog keeps its chosen files and fields for the Save. Runner up: a two step dialog that stores the client file between steps, which would mean a decrypt in the web process.
- **PKCE plus `state`**, because the code passes through the admin's own browser at a loopback address any local program could listen on; without the server held verifier, the code is useless.
- **The sender comes from the `id_token`**, not a userinfo call: it arrives in the same TLS reply from Google's token endpoint, so a second call adds nothing. `gmail.send` alone can't read the profile.
- **`prompt=consent` with `access_type=offline`**, so Google returns a refresh token on every sign in, including a second one for the same account.
- **The marker is a timestamp** (`google_rejected_at`), not a status list, so it needs no `CHECK` list or enum, and it gives the badge its "since" day.
- **The token cache stamp becomes `secret_updated_at`** (cross check, 2026-10-16): `updated_at` moves on the worker's own marker writes, and a marker guarded by `secret_updated_at` can't flag a secret saved after the worker read its config. Runner up: exclude `google_rejected_at` from the `updated_at` trigger, which hides a real change from `updated_at`.
- **The action, not the catalog, runs the code exchange**: cookies and the token endpoint stay at the edge in `app/admin/actions.ts` and `server/google/`, and `server/catalog/api-keys.ts` keeps taking finished values, as it does for a parsed key file.
- **The loopback port is a fixed constant** (`47613`): the redirect URI must match exactly between the sign in and the code exchange, and an uncommon port makes a stray local listener unlikely.
- **An exchange outage keeps the sign in** (after the build, 2026-10-16): the first draft deleted the cookie after every exchange attempt but marked an outage "no restart", so "Try again" could only end at "expired". A timeout, network error, 429, or 5xx means Google may never have seen the code, so the cookie and the pasted address stay and the same save is retried; if Google did redeem the code, the retry gets `invalid_grant` and starts over cleanly. The code is still single use at Google and the verifier never leaves the server, so keeping the cookie a little longer adds no risk inside its 10 minutes. Runner up: always restart after an outage, which is a simpler rule but costs a fresh Google sign in even when the code was never spent.
- **Smaller corrections from the build** (2026-10-16): a 401 on the calendar read right after a sign in means Google refused a token it just issued, which only a new sign in fixes, so it uses the `invalid_grant` message and restarts; the two switch refusals get their own codes (`google_file_switch`, `google_sign_in_switch`) because their messages differ from the calendar and sender ones; an oversized client file says "The OAuth client file is too large."; and the refresh token scan names `server/google/verify.ts`, where this spec already placed `verifyGoogleSignIn`, instead of `server/google/token.ts`, which reaches the token only through a type.

## Amendment 2026-10-16, after the review

The review (`docs/reviews/2026-10-16-feat-email-delivery-booking-confirmations.md`) and the first manual run found three things the spec had decided wrong or not at all.

### The invite attached once (AC-15, AC-17)

iOS Mail showed no body, only `mime-attachment.ics` and `invite.ics`. AC-15 asked for MailComposer's `icalEvent`, which puts a `text/calendar` part **last** inside `multipart/alternative` and also adds an `application/ics` attachment. RFC 2046 makes the last alternative the preferred one, so a client that honors it shows the calendar part instead of the HTML, and the lab links live only in the HTML.

- **One `text/calendar; method=…` attachment beside `multipart/alternative`, inside `multipart/mixed` (chosen).** Every client's preferred alternative is the HTML. Gmail still reads the attachment as an invite because it carries `method`, Apple Mail offers it as an event to add, and the learner's calendar follows by `UID` and `SEQUENCE` as before. One copy also means no second `.ics` file in the attachment list. Cost: Outlook may show it as a file to open, not a meeting request with its own bar. That's acceptable, since the invite never asks for a reply (`RSVP=FALSE`) and AC-17 already lets the learner click Add.
- **Keep the calendar alternative but move it between text and HTML.** Outlook keeps its meeting request bar, but the invite is still sent twice, nodemailer has no option for that order (the tree would be built by hand), and the result relies on each client handling a three way alternative well. Runner up.
- **Calendar alternative only, no attachment.** Apple Mail and Outlook read the attachment form best, and iOS would still see a non HTML alternative. Rejected.

The bug got through because the tests snapshot the HTML, the text, and the `.ics` separately, and the compose test checks only that `multipart/alternative` appears. So the amendment adds a test that asserts the whole tree. The manual matrix is rerun from scratch, since its 2026-10-16 rows came from the old tree.

### The booked email's time zone (AC-6, AC-11)

A returning learner who books through the guest form keeps their stored `users.timezone`, because the saga's insert does `ON CONFLICT DO NOTHING`. The success screen showed the zone they picked, and the email showed the stored one.

- **Snapshot the zone the booking screen showed, for booked only (chosen).** The email matches the screen the learner just saw. Reschedule and cancel happen signed in (or by an admin), where every screen uses `users.timezone`, so their emails keep using it. Each email matches the screen that made its change, and nothing about the account changes.
- **Overwrite `users.timezone` with the picked zone.** One zone everywhere, but an unauthenticated form would then edit an existing account's settings by typing its email. Rejected.
- **Show the stored zone on the success screen for an existing account.** One zone everywhere, but it would show an account's stored zone to anyone who types that email on `/book`, and it surprises the learner who just picked a zone. Rejected.

### The rescheduled intro and the password box (AC-12)

The rescheduled email reused the booked intro ("your reservation is confirmed"). Its password box told everyone, including existing users and anyone rescheduling, that a set password email was coming.

- **Rescheduled gets its own intro. The box shows only on a booked email for an account that booking created (chosen)**, keyed by the saga's `created`, which is exactly when that transaction queues the welcome job. The box drops the "Existing users…" sentence, because existing users no longer see it. The promise of a separate email comes true with feature 16, the same promise the `/book` success screen already makes. Runner up: drive the box from `users.set_password_pending`. That also catches an admin created learner who never set a password, but that learner's welcome job was queued at creation, not by this booking, so "you will receive" would be wrong for them.
- **Hide the box until feature 16 ships.** Simpler, but then a new learner's first email never mentions setting a password, while the success screen does. Rejected.
