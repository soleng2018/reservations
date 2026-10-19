# Verify: Set password and welcome email · spec 0014 · updated 2026-10-17
_Steps derived from spec 0014 acceptance criteria. `/check verify` runs these; `/test` locks the durable ones._

## Build task 1: Authentik spike (2026-10-17, on dev)

Run by hand against the shared Authentik (`authentik.dev.app.nile-global.cloud`, v2026.2.1) with a fresh learner `hol-test-spike-1792298994736@example.test` (pk 96, path `hol/learners`, created with the provisioning token and deleted afterwards with the master token). Nothing pre-existing was changed.

- [x] (a) `POST /core/users/96/recovery/` with `token_duration: "minutes=10"` returns `https://authentik.dev.app.nile-global.cloud/if/flow/hol-recovery/?flow_token=<key>`; the stored token's `expires` is ten minutes out → AC-12
- [x] (b) The app's own sign in (Sign in on `/reservations`) gave an authorize request; its path plus search was added as `&next=<encoded>` to the recovery link. After the password, Authentik went to `/application/o/authorize/?…` with the same `state`, `nonce`, `code_challenge`, and `redirect_uri` (then to `default-authentication-flow`, since `hol-recovery` has no login stage yet). **Authentik keeps `next` on a token flow: the main landing path is used, and the AC-11 fallback (`hol-recovery-return`, `GET /auth/start`) is not built.** → AC-11
- [x] (c) With the `hol-recovery-login` stage, the learner lands on the app signed in: not run on a throwaway copy, because a recovery link always opens the brand's recovery flow and a throwaway brand needs another domain. Proven instead by the tracer (below) after the owner approved `npm run authentik:setup -- --apply` (2026-10-17: the dry run showed only "create user login stage hol-recovery-login" and the order 30 binding; the apply did exactly that) → AC-11
- [x] (d) The same link opened a second time still draws the password form, but submitting it answers "Request has been denied. No user found and can't create new user." The token is used up when its flow **opens**: a fresh link's token count went 1 → 0 on page load, before any submit → AC-12
- [x] (e) Asked twice, 3 seconds apart, with nothing opened: the same `flow_token` both times (identifier `<user uid>-password-reset`), and the second request moved `expires` forward (04:59:55 → 04:59:58 UTC). The later request's expiry wins → AC-12
- [x] (f) The recovery link's origin, the discovery `authorization_endpoint` origin, and the issuer host are all `https://authentik.dev.app.nile-global.cloud` → AC-10 step 6

## Build task 2: tracer (2026-10-17, on dev)

- [x] `createLearner` added `hol-test-tracer-1792300126459@example.test` (real Authentik), which queued `send_welcome` with `appUrl` `http://10.1.255.18:3000`. The real runner and handler sent it (Gmail's request captured on its way out to read the link): one `sent` welcome row, `sent_to` the dev inbox mehrashiv@gmail.com, subject `Set your password for Nile Hands-On Labs`, one link row expiring 72 hours after it was made. The 52 older `send_welcome` jobs (no `appUrl`) finished `done` with no email row → AC-1, AC-2, AC-4, AC-6, AC-15
- [x] Opening the link showed "Set your password", "for hol-test-tracer-…@example.test"; Set my password went to `hol-recovery` with `next=/application/o/authorize/…`; after the password the browser landed on `http://10.1.255.18:3000/reservations` as "Welcome back, Tracer". Afterwards `set_password_pending` is false, `email_verified_at` is set, and the link ended `used` → AC-9, AC-10, AC-11
- [x] The same link opened again, signed in and in a fresh browser, shows "Your password is already set." → AC-9, AC-12

## UI / manual

Verify run, 2026-10-18 (`/check verify`): run on dev against the shared Authentik and database, with the owner doing the inbox steps. Test learners: `dev-verify-4900825d-…` (scripted), `john@shivmehra.com` (the owner's real address), `dev-resend-1018` and `dev-change-b-1018` (owner, by hand). For the real address run, the `GOOGLE` key's Ops BCC was set to mehrashiv@gmail.com at 12:31 AM PT, before the 12:32 AM send, then cleared afterwards.

- [x] On the console, add a learner with a real address you own (not `dev-` or `hol-test-`), with the worker running → one email "Set your password for Nile Hands-On Labs" arrives with no `[dev] ` prefix; "Show original" has no `Bcc` line even though the `GOOGLE` key has an Ops BCC, and the Ops mailbox got no copy → AC-1, AC-5, AC-7 (john@shivmehra.com: one job, one Sent row, subject with no prefix. The Ops mailbox got the later Booked email as "bcc: me" but no copy of the welcome, so the BCC was live and the welcome skipped it)
- [x] Run the mail client matrix on that email (iOS Mail and Gmail web, the pair the owner accepted for spec 0013): the Nile logo, "Set your password", "Hi <first name>, your Nile Hands-On Labs account for <address> is ready…", the orange "Set my password" button, "This link works once and expires <time>." in the learner's zone, the fallback line with the link as text, "Didn't expect this? You can ignore this email.", and the footer all show; the preview line reads "Set a password to manage your Nile Hands-On Lab reservations." → AC-7 (iOS Mail on John's email, "expires Wed, Oct 21, 2026, 12:32 AM PDT"; Gmail web on the `[dev]` copy of the same template. Every line and the preview show. In a very wide Gmail window the card sits to the right, as booking emails do: the shared `EmailFrame`, noted for review)
- [x] `/admin/users/<that learner>`: Emails lists the welcome row as Sent, To the learner's address → AC-8 (Sun, Oct 18, 12:32 AM PDT · Welcome · john@shivmehra.com · Sent)
- [x] Click the button → the app's page shows "Set your password" and "for <address>"; Set my password → Authentik's "Set your password" (password twice) → back on `/reservations` as "Welcome back, <first name>" with no other sign in step → AC-9, AC-10, AC-11 ("Welcome back, John"; the link ended `used`, pending cleared, verified set)
- [x] Click the same email's button again (signed in, then in a private window) → "Your password is already set." with a Sign in button → AC-9, AC-12 (both, owner confirmed)
- [x] For a second pending learner, press Resend on the console once so two emails arrive. Click the newer email's button, and stop on Authentik's password page. Now open the older email's link → "This link has expired or was already used." with the resend form → AC-12, AC-13 (`dev-resend-1018`: sent 12:45:03 and 12:46:09 AM PT; the newer ended `used` and the older `other_used`, both at 12:46:31)
- [x] Add a learner at address A you own, wait for the email, then edit the learner's email to address B you own → A's link shows "This link has expired or was already used."; B gets a new email whose link signs in → AC-14 (A ended `email_changed` 8 seconds after its send; B's email arrived. The first click on B's link stalled loading Authentik in a Brave private window (the app answered in 0.4 seconds, Authentik in 0.15 seconds from the host), so the password was not set and that link was used up. A console Resend gave a new link that signed in to `/reservations`)
- [x] Slow learner: open a fresh link, click Set my password, wait 6 minutes on Authentik's password page (past the 5 minute state cookie), then set the password → the app shows `/auth/error?error=state_mismatch` with "Sign in timed out", "Your sign in expired before it finished. Sign in again to continue.", a Sign in button, and Back to the home page. Click Sign in → back on `/reservations` signed in, with no password prompt → AC-19 (scripted, a 6 minute 15 second wait)
- [x] Lost state row: open `/api/auth/callback/authentik?state=bogus&code=x` in a fresh browser → redirected to `/auth/error?error=state_mismatch` with the same "Sign in timed out" view, not Better Auth's own error page or `/?error=` (the `onAPIError.errorURL` path, which a learner past 10 minutes can hit) → AC-19 (it failed at first: the dev server had run since Oct 10, and `auth()` is cached on `globalThis`, so the new `onAPIError` was not live. After a restart it passed, and no `state` at all gives `state_not_found` on the same page. A Better Auth config change needs a dev server restart)
- [x] `npm run authentik:setup` (dry run) → "Recovery flow" reads `ok` for `hol-recovery-password`, `hol-recovery-login`, and bindings 10, 20, 30, and "Nothing was written" → AC-11

## Commands

- [x] `npx vitest run server/jobs/send-welcome.test.ts server/auth/start-set-password.test.ts server/auth/set-password-links.test.ts lib/set-password-link.test.ts lib/welcome-email.test.ts lib/auth-errors.test.ts server/email/compose.test.ts tests/server-actions-require.test.ts scripts/authentik-setup-plan.test.ts` → all pass; with no database the DB cases skip, so fewer passes means they didn't run → AC-1 to AC-19 (148 of 148, none skipped)
- [x] `npx playwright test e2e/set-password.spec.ts` (dev server up, hol-test passwords and `.env.local` present) → 2 pass → AC-9 to AC-12
- [x] With `WORKER_ENABLED=true`, `npm run worker` starts (the smoke check renders the booking and the welcome samples) → AC-17

## AC-9 referrer amendment (2026-10-18, `/check verify`, on dev)

Found by the owner: Set my password clicked before hydration showed "Invalid Server Actions request" under `no-referrer` (a native POST carried `Origin: null`). Fixed with `strict-origin` on `feat/set-password-referrer`.

- [x] `npx playwright test e2e/set-password.spec.ts e2e/set-password-public.spec.ts` → 7 pass, including the native POST check (Origin `http://10.1.255.18:3000`, Referer `http://10.1.255.18:3000/`, no token) and the full sign in flow → AC-9, AC-10, AC-11, AC-12
- [x] Click before hydration, on a live link: a fresh `dev-prehydrate-…@nile-test.invalid` learner, the link opened with JavaScript off, Set my password → a native POST (no `Next-Action` header) with the real Origin and an origin only Referer, a redirect to `https://authentik.dev.app.nile-global.cloud/if/flow/hol-recovery/`, and the link ended `used` → AC-9, AC-10 (a throwaway Playwright spec, deleted after the run; the learner is left behind, as the e2e learners are)
- [x] `npx vitest run app/set-password` → 3 pass (`metadata.referrer` is `strict-origin`) → AC-9
- [x] `npm run db:codegen -- --verify` → no drift (migration `0011` applied) → AC-4, AC-16 (and the live table has every column, constraint, and index in the data model sketch, with RLS on)

## Value sourcing

- [x] Eligibility (`users` row, `FOR SHARE`): deactivate a pending learner before the worker runs their job → no email and no Emails row → AC-1
- [x] First name (`firstName(users.name)`): a learner named "Ana Maria Lopez" → the email says "Hi Ana," → AC-7
- [x] Job age (`jobs.created_at` against `dbNow`): covered by the 72 hours and 71 hours 59 minutes cases in `send-welcome.test.ts` → AC-2
- [x] Covered already (welcome rows): an add followed at once by an email fix sends one email, to the fixed address → AC-3 (the original job sent to the fixed address; the email change job then finished `done` with no row)
- [x] Expiry text (`formatDateTime(expiresAt, users.timezone)`): a learner in `Asia/Kolkata` → the email's expiry reads in GMT+5:30, 72 hours after the send; a learner in `UTC` → it ends "UTC" → AC-7 ("Wed, Oct 21, 2026, 11:17 AM GMT+5:30" for a 05:47 UTC send)
- [x] Link base (`payload.appUrl`): a learner added from dev (`http://10.1.255.18:3000`) gets a link on that origin; one added from production gets the production origin → AC-4, AC-15 (dev only: every job carried `appUrl` and the link used it. Production was not run; the owner accepted dev only on 2026-10-18)
- [x] To and `[dev] ` (`routeEmail`, no BCC): a `hol-test-` learner's email goes to the dev inbox with `[dev] ` and no Bcc; with no dev inbox it shows Suppressed "Test address and no dev inbox is set." → AC-5 (a `dev-` learner's email reached mehrashiv@gmail.com as "[dev] Set your password…" with no Bcc. The no dev inbox case rests on the handler tests; the owner accepted that on 2026-10-18 rather than clear the shared key)
- [x] Page state and the address shown (`set_password_links` joined to `users`, DB `now()`): the Live page's "for <address>" is the lowercased address the email went to → AC-9 (`Dev-Verify-…-E@Nile-Test.invalid` showed as lowercase)
- [x] Action IP (`clientIp`): covered by the miss limit cases in `start-set-password.test.ts` (30 misses, then `limited`; live clicks never count) → AC-10
- [x] Authentik recovery link (`issueSetPasswordLink`, `minutes=10`): the click goes to `https://authentik.dev.app.nile-global.cloud/if/flow/hol-recovery/?flow_token=…&next=%2Fapplication%2Fo%2Fauthorize%2F…` → AC-10, AC-11
- [x] Authorize path (`signInSocial(...).url`): `next` carries the same `state` the app's state cookie holds, so the callback signs in rather than failing `state_mismatch` → AC-10, AC-11
- [x] Landing (`onSessionCreate`): after the first sign in, the learner's row has `set_password_pending = false` and `email_verified_at` set → AC-11

## Acceptance-criteria coverage

- AC-1: tracer, handler tests (send, four skips), Value sourcing eligibility
- AC-2: tracer (52 old jobs), handler tests (no `appUrl`, 72 hours, just under)
- AC-3: handler tests (original plus email change, resend after a send, suppressed once), Value sourcing covered
- AC-4: handler test (hash, 43 characters, 72 hours, URL), link tests, leak scan
- AC-5: real address step, handler tests (no Bcc, dev inbox, no dev inbox), compose test
- AC-6: handler tests (sent, retry, breaker, final)
- AC-7: matrix step, compose tests and snapshots, Value sourcing name and expiry
- AC-8: console step, handler test (details), pure test
- AC-9: click steps, Playwright, click tests, `linkView` tests
- AC-10: click steps, click tests (happy, unavailable twice, sign in can't start, guard, origin, dead cases, limit)
- AC-11: spike (b), (c), tracer, Playwright, setup dry run step
- AC-12: spike (d), (e), Already set step, click tests, Playwright
- AC-13: two emails step, click test (sibling `other_used`), handler test (both links live)
- AC-14: email fix step, link tests (ended `email_changed`, the backstop), `emailChangeKey` test; the lock order race of a click and an email change at once is not tested, since DB tests run in one rolled back transaction and can't hold two
- AC-15: tracer (`appUrl` in the payload), `learners.test.ts` key
- AC-16: purge test
- AC-17: worker start step
- AC-18: leak scans in the handler and click tests, allow list scan
- AC-19: slow learner step, lost state row step, `auth-errors.test.ts` (`state_mismatch` gives `timed_out` with Sign in; reason first; the rest unchanged)
