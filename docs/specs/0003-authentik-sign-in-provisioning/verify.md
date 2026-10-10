# Verify: Authentik sign in & provisioning · spec 0003 · updated 2026-10-07
_Steps derived from spec 0003 acceptance criteria. `/check verify` runs these; `/test` locks the durable ones._

Prerequisites: the setup script has run, `AUTHENTIK_PROVISIONING_TOKEN_FILE` is set, dev uses the LAN IP (`http://10.1.255.18:3000`), and Turnstile uses Cloudflare's test keys.

## UI / manual
- [x] Open `ADMIN_ENTRY_PATH` (`/l0gin`) as a `hol-admins` member → "Sign in with SSO" → Authentik → land on `/admin`; no password field in the app → AC-1
- [x] Sign in at `/reservations` as an admin → land on `/admin`; as a learner at `/l0gin` → land on `/reservations` → AC-2
- [x] As a learner, open `/admin` → plain "Not authorized" page, no admin hints → AC-2
- [x] View source of `/`, `/reservations`, `/auth/error`: no link to `/l0gin`; `curl -I /admin` shows `X-Robots-Tag: noindex` → AC-3
- [x] Sign in with an Authentik user that has no `users` row and is not an admin → "We couldn't find reservations for this account" with "Reserve a lab", and no `hol_auth.session` row → AC-10
- [x] A new learner's first sign in → `users.email_verified_at` set, `set_password_pending` false; a second sign in leaves `email_verified_at` unchanged → AC-7
- [x] Sign out as a learner → straight back at `/` with no Authentik page; as an admin → straight back at `/l0gin`; the Authentik API lists no sessions for that user; the next sign in asks for a password → AC-12
- [x] Sign out with `AUTHENTIK_URL` blocked → app session gone, lands on `/auth/error?reason=signout_partial` → AC-12
- [x] As `hol-test-learner` (on `hol/learners`), in a clean browser: open `leo` → Authentik access denied; sign in to HOL, then open `leo` and `cloudflare-integration` → both denied; in a fresh profile open `leo` first, then HOL → HOL works → AC-17
- [x] As `hol-test-admin`: sign in to HOL, then open `leo` → opens → AC-17
- [x] Book as a guest with a new email (feature 6's form, or `bookAsGuest` from a script) → exactly one Authentik user: username = lowercased email, path `hol/learners`, attributes `hol_learner: true` and `hol_user_id` = the `users.id`, no password; one `send_welcome` job with key `welcome:<users.id>`; audit `user.created_in_authentik` → AC-5, AC-6, AC-16
- [x] Book again with the same email (different case) → no new Authentik user, no new welcome job → AC-5, AC-6
- [x] Book with an existing untagged non admin Authentik user's email → the two attributes are added, nothing else changes; audit `user.tagged_in_authentik` → AC-5
- [x] Book with an admin's email (one with a `users` row, and one only in Authentik) → "This email can't be used for booking.", audit `booking.refused_admin_email`, no booking and no orphan row left → AC-5, AC-16
- [x] Book with an email whose lowercase form is another Authentik user's username → unavailable message, audit `booking.refused_username_taken` → AC-5
- [x] Block the Authentik host (or point `AUTHENTIK_URL` at a black hole) and book → after at most 10 seconds the "temporarily unavailable" message; no booking, no `users` row, no Authentik user → AC-15
- [x] Run the `send_welcome` job for a pending learner → a recovery link for the `hol-recovery` flow, host = `AUTHENTIK_URL`, valid 72 hours; opening it sets a password → AC-6
- [x] On `/reservations` signed out, submit "Resend the email" for a pending learner → generic message, one new `send_welcome` job, audit `set_password.resent`; for an unknown email, an admin, or a verified learner → the same message and no job → AC-8
- [x] Submit resend 4 times in one hour for the same email → the 4th makes no job; 11 times from one IP → the 11th makes no job; `rate_limits` counts every attempt → AC-8
- [x] Call `deactivateLearner` for a signed in learner → Authentik user inactive, their Authentik sessions and `hol_auth.session` rows gone, `users.status` deactivated, audit `user.deactivated`; their next sign in is refused by Authentik → AC-9
- [x] Call `reactivateLearner` → they can sign in again; audit `user.reactivated` → AC-9
- [x] Call `deactivateLearner` on an admin → refused (`is_admin`), no Authentik write → AC-4, AC-9

## Commands
- [x] `npm test` → guard tests cover each refusal (admin target, superuser, untagged user outside the tag step, non `pod-` group) with no write recorded → AC-4
- [x] `npm test -- tests/server-actions-require.test.ts` → every Server Action calls `require*` or is on the allow list → AC-14
- [x] `grep -rn MASTER server app lib` → no runtime read of the master token → AC-13
- [x] `npm run authentik:setup` twice (dry run) → the second run reports only `ok` lines → AC-13
- [x] An admin session older than 2 hours (edit `hol_auth.session.expiresAt`) → sent back to sign in → AC-11

## Value sourcing
- [x] Role: remove a user from `hol-admins`, sign in again → learner (or refused), never admin → groups claim
- [x] User match: change a learner's email in Authentik, sign in → still matched by `sub` → `authentik_user_pk`
- [x] Guest saga username: book with `Mixed@Case.test` → username `mixed@case.test`
- [x] Recovery link: run the job twice → each run asks Authentik (no stored link); while the first link is still valid, both runs get the same link
- [x] Session expiry: admin session `expiresAt` ≈ now + 2h, learner ≈ now + 8h
- [x] Resend eligibility: flip `set_password_pending` to false → resend makes no job
- [x] Resend limit IP: send with two different `CF-Connecting-IP` headers → separate buckets
- [x] Guard admin membership: add a learner to `hol-admins` in Authentik (DB still says learner) → `issueSetPasswordLink` refuses → read from Authentik, not the DB
- [x] Deactivate sessions: two browser sessions for one learner → both end

## Acceptance-criteria coverage
- AC-1 sign in admin · AC-2 role landing, learner denied · AC-3 no admin link, noindex · AC-4 guard tests, admin deactivate refused · AC-5 new, reused, tagged, admin, username taken · AC-6 welcome job and link · AC-7 first sign in verifies · AC-8 resend message, eligibility, limits · AC-9 deactivate, reactivate · AC-10 unknown user · AC-11 session length · AC-12 sign out · AC-13 master token, setup idempotent · AC-14 action coverage test · AC-15 Authentik down · AC-16 audit rows across the steps above · AC-17 learner isolation in every order · AC-18 learners created `external`
