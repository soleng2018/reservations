# 0003. Authentik sign in and learner provisioning

**Date**: 2026-10-06
**Status**: In Progress

## Summary

Admins and learners both sign in through one Authentik OIDC application (OIDC is the standard "sign in with another site" protocol). The app learns who is an admin from an Authentik group named `hol-admins` and gives every other known person the learner role. The app also creates, tags, deactivates, and reactivates learners in Authentik with a limited provisioning token, and it adds code guards so that token can never touch an admin or any group other than a `pod-*` group. A learner's email counts as verified the first time they sign in, which they can only do after they open the set password link we email them.

## Requirements

**User stories**:
- As an admin, I want to open the unlisted admin URL, press "Sign in with SSO", and land in the console, without typing a password into the app.
- As a learner, I want to sign in from "Manage an existing reservation" and see only my own area.
- As a new guest, I want my booking to create my account and email me a link to set my password.
- As the owner, I want a leaked runtime token to be unable to change an admin or the app's own sign in setup.

**Acceptance criteria**:
- **AC-1**: An Authentik user in group `hol-admins` who opens `ADMIN_ENTRY_PATH` (default `/l0gin`) and presses "Sign in with SSO" is sent to Authentik, returns, and lands on `/admin`. No password field exists anywhere in the app.
- **AC-2**: The role is decided on every sign in from the `groups` claim: in `hol-admins` → `admin`, else `learner`. Either entry point works for either role, and the role decides the landing (`/admin` or `/reservations`). A learner who opens any `/admin` page or calls an admin Server Action gets a plain "not authorized" page or error, with no admin hints, and an admin gets the console.
- **AC-3**: No learner facing page links to `ADMIN_ENTRY_PATH` or shows an admin sign in or sign up control. Admin pages send `X-Robots-Tag: noindex`.
- **AC-4**: The app has no code path that creates an admin, adds anyone to `hol-admins`, or changes an admin user. Every Authentik write goes through `server/authentik/guard.ts`: user writes are refused when the target is in `hol-admins`, or (for anything other than the guest saga's tag step) lacks `attributes.hol_learner = true`; group writes are refused unless the group name starts with `pod-`. Unit tests cover each refusal.
- **AC-5**: A guest booking for a new email creates exactly one Authentik user (username = the lowercased email, `name`, `email`, path `hol/learners`, `is_active` true, attributes `{ hol_learner: true, hol_user_id: <users.id> }`, no password). A known non admin email reuses its Authentik user (looked up by email); the only change made is adding the two attributes if they are missing. A username taken by a different email returns `unavailable` and is audited. An admin email, whether caught from the `users` row in step 1 or from Authentik in step 2 (then compensated like any failure), is refused with "This email can't be used for booking." and audited as `booking.refused_admin_email`. A deactivated user gets the generic refusal.
- **AC-6**: For a user this saga created, after the booking is confirmed (saga step 3), the app enqueues a `send_welcome` job (idempotency key `welcome:<users.id>`). The job requests the recovery link from Authentik when it sends, so a failure retries and never undoes the booking. Feature 16 renders the email. The link is valid 72 hours. A reused user gets no set password email.
- **AC-7**: The first successful learner sign in sets `users.email_verified_at` (never cleared afterwards) and clears `users.set_password_pending`. Lab links are gated on `email_verified_at` (feature 14).
- **AC-8**: "Resend the set password email" (on `/reservations` before sign in and on the booking success screen) accepts an email and a Turnstile token, and always replies with the same generic message. It only enqueues `send_welcome` when the email belongs to an active learner with `set_password_pending = true`. Limits use fixed hourly buckets in `rate_limits`, where every attempt counts: 3 per email and 10 per IP.
- **AC-9**: `deactivateLearner` sets the Authentik user `is_active = false`, deletes their Authentik sessions, deletes their `hol_auth.session` rows, and triggers an access reconcile. After this, Authentik itself refuses the sign in with its inactive account error. The app's "This account is deactivated" page shows only if Authentik lets the user in while the app status is `deactivated` (a race or drift). `reactivateLearner` sets `is_active = true`. Both are refused for admins by the guard. (Feature 10 adds the console UI and booking side effects.)
- **AC-10**: An Authentik user with no `users` row who is not in `hol-admins` gets no app session and no `hol_auth` row. They see "We couldn't find reservations for this account" with a "Reserve a lab" link. An admin with no row gets one created on first sign in (`role = admin`, name from the claim, company `Nile`, timezone `UTC`, `authentik_user_pk` from `sub`). If a learner row (one that has bookings, or role learner) appears in `hol-admins`, the sign in is refused and audited as `admin.sign_in_refused`; admins must use a separate account.
- **AC-11**: Admin sessions last 2 hours and learner sessions 8 hours, with no sliding extension (`updateAge` at least the session length). Someone removed from `hol-admins` loses the console at their next sign in, so within 2 hours at most.
- **AC-12**: Sign out reads the role, deletes the app session, then redirects to Authentik's end session URL with `id_token_hint` (the stored `account.idToken`) and `post_logout_redirect_uri` set to `/` (learner) or `ADMIN_ENTRY_PATH` (admin), both registered on the provider for each base URL.
- **AC-13**: `web` and `worker` never load the master token. `npm run authentik:setup` (master token and `APP_URLS` passed for that run only) idempotently creates or updates: the OIDC provider (`sub_mode` = user id, default signing certificate, redirect and post logout URIs for every URL in `APP_URLS`, and the `profile` scope checked to carry `groups`), the application, the `hol-admins` group, the `hol/learners` path, the `hol-recovery` flow (set a password, then done) as the brand's recovery flow with 72 hour links, and the provisioning service account and its RBAC role. It prints the client id, the client secret, and the token creation steps. A second run changes nothing.
- **AC-14**: Every protected page and Server Action calls `requireAdmin()` or `requireLearner()` from `server/auth/require.ts`, and a test fails if any Server Action does not.
- **AC-15**: If Authentik is unreachable or times out (10 seconds), sign in and guest booking show "Sign in is temporarily unavailable, try again shortly" and nothing is half done (the saga compensates, spec 0002).
- **AC-16**: The audit log records `admin.signed_in`, `admin.sign_in_refused` (an admin group member blocked, e.g. no email claim), `user.created_in_authentik`, `user.tagged_in_authentik`, `user.deactivated`, `user.reactivated`, `set_password.resent`, and `booking.refused_admin_email`. Learner sign ins go to the app logs only.

## Decision

**Chosen option**: Option 1: group claim roles, a guarded provisioning token, and verification on first sign in.

The role comes from the `hol-admins` group in the OIDC `groups` claim on each sign in. All runtime Authentik writes use the RBAC limited provisioning token behind code guards (an admin may never be the target; group writes only on `pod-*`). The first sign in marks the email verified.

**Implementation skills**: `better-auth-best-practices` (`better-auth/skills`, `.claude/skills/better-auth-best-practices/`) · `zod` (`pproenca/dot-skills`, `.claude/skills/zod/`) · `kysely` (`mindrally/skills`, `.claude/skills/kysely/`) · `vitest` (`antfu/skills`, `.claude/skills/vitest/`) · `playwright-best-practices` (`currents-dev/playwright-best-practices-skill`, `.claude/skills/playwright-best-practices/`)

## Rationale

Reasoning and options: see [rationale.md](rationale.md).

## Feature design

**Data model sketch** (adds to spec 0002, no new `hol_app` business tables):

| Store | Change |
|---|---|
| `hol_auth.user`, `session`, `account`, `verification` | Generated once by the Better Auth CLI, committed as migration `0002_better_auth.sql` |
| `hol_app.users.auth_user_id` | `text`, unique, FK `hol_auth."user"(id) ON DELETE SET NULL` (planned in 0002), same migration |
| `hol_app.users.role` | Rewritten from the groups claim on every sign in |
| `hol_app.users.email_verified_at` | Set on the first learner sign in, if null |
| `hol_app.users.set_password_pending` | New: `boolean not null default false`. True when the saga creates the Authentik user, false at the first sign in. It gates resend. |
| `hol_app.audit_events` | Created now per spec 0002's shape (the first feature that writes it) |
| `hol_app.rate_limits` | Created now per spec 0002's shape (keys `resend:email:<lower email>`, `resend:ip:<ip>`) |
| Authentik user | Path `hol/learners`, attributes `hol_learner: true`, `hol_user_id: <uuid>` |
| Authentik group | `hol-admins` (owner adds members by hand) |

**State transitions**:
- Sign in: Authentik callback → generic OAuth `getUserInfo` (runs before Better Auth writes any row; sign up is disabled except for the cases below) → `resolveSignIn(claims, usersRow)` (a pure function; the row is looked up by `sub` = `authentik_user_pk`, and by email only to link an admin row the first time). A refusal throws, which redirects to `/auth/error?reason=…` → `admin` (upsert the row with the admin role, 2h session) | `learner` (row exists and is active: link `auth_user_id`, set `email_verified_at` if null, 8h session) | `refused_unknown` | `refused_deactivated` | `refused_no_email` (no session).
- Learner identity: (none) → created in Authentik with no password → password set via the recovery link → first sign in (verified) → deactivated ⇄ active.

**API surface**:

| Endpoint / action | Method | Key inputs | Key outputs | Auth | Key errors |
|---|---|---|---|---|---|
| `/api/auth/[...all]` | GET/POST | Better Auth (generic OAuth `authentik`, PKCE) | session cookie, redirect | public | callback state mismatch → `/auth/error` |
| `ADMIN_ENTRY_PATH` page | GET | none | "Sign in with SSO" button (`callbackURL=/admin`) | public, noindex | none |
| `/reservations` page | GET | session (optional) | sign in button and resend link, or the learner area | public / learner | none |
| `/auth/error` page | GET | `reason`: `unknown` \| `deactivated` \| `unavailable` \| `not_authorized` | the matching plain message | public | none |
| `signOut` action | POST | session | redirect to Authentik end session | any session | none |
| `resendSetPassword` action | POST | `email` (req), Turnstile token (req) | generic message | public | rate limited (same message) |
| `server/auth/require.ts` `requireAdmin` / `requireLearner` | fn | request headers | `{ user, session }` | n/a | redirect `/auth/error?reason=not_authorized` or the entry page |
| `server/authentik/learners.ts` `findOrCreateLearner` | fn | `email`, `name`, `holUserId` | `Result<{ pk, created }, 'is_admin' \| 'unavailable'>` | provisioning token | is_admin, unavailable |
| `issueSetPasswordLink` | fn | `pk` | `Result<url, 'unavailable'>` | provisioning token | unavailable |
| `deactivateLearner` / `reactivateLearner` | fn | `usersId`, `actorId` | `Result<void, 'is_admin' \| 'unavailable'>` | provisioning token | refused by guard |
| `scripts/authentik-setup.ts` | CLI | `AUTHENTIK_MASTER_TOKEN` (that run only) | client id, secret, steps | master token | prints a diff, then fails on API errors |

**Value sourcing**:

| Action | Value | Source |
|---|---|---|
| sign in | role | `groups` claim (Authentik `profile` scope) contains `hol-admins` |
| sign in | user match | `sub` claim (Authentik user pk, via `sub_mode`) against `users.authentik_user_pk`; the email claim is used only to link an admin row the first time |
| sign in (new admin row) | name, company, timezone | name claim, `Nile`, `UTC` |
| guest saga | Authentik username | lowercased email |
| welcome job | recovery link | requested from Authentik when the job runs (`hol-recovery` flow, host = `AUTHENTIK_URL`) |
| sign in | session expiry | role → `ADMIN_SESSION_HOURS` (2) or `LEARNER_SESSION_HOURS` (8), set in the session create hook |
| sign in | `email_verified_at` | DB `now()` on the first learner session |
| sign out | end session URL | OIDC discovery `end_session_endpoint` from `AUTHENTIK_URL` |
| guest saga | Authentik user pk, created flag | `findOrCreateLearner` → `users.authentik_user_pk`, `authentik_pending_saga` (spec 0002) |
| set password email | link, expiry | Authentik recovery link API; 72h is set on the recovery flow by the setup script |
| resend | eligibility | `users.role = learner`, `status = active`, `set_password_pending = true` |
| resend | Turnstile result | `server/turnstile.ts` `verifyTurnstile` |
| resend limits | counters | `rate_limits`, IP from `CF-Connecting-IP` (spec 0001) |
| guards | admin membership | Authentik user `groups` read before each user write (never trusted from the DB) |
| deactivate | sessions to kill | Authentik sessions filtered by user pk; `hol_auth.session` where `userId = users.auth_user_id` |

**Key invariants**:
- Only `hol-admins` membership in Authentik grants admin. `users.role` is a cache rewritten on each sign in and is never edited by app code otherwise.
- No runtime code reads the master token; `server/env.ts` has no field for it.
- Every Authentik user or group write passes `guard.ts`, which re-reads the target from Authentik first.
- One `users` row per lowercased email; one Authentik user per `users` row (`authentik_user_pk` unique).
- No session is ever created for a deactivated or unknown non admin user.

**Security model**:
- Public: the landing page, the admin entry page (unlisted, noindex), `/reservations` before sign in, `/auth/error`, and the resend action (Turnstile plus rate limit, generic reply so it never reveals whether an account exists).
- Learner: only their own rows; the ownership filter is applied inside the query helpers, keyed by `session.user → users.id`.
- Admin: the console; authorization is re-checked in every page and action (AC-14), never only in `proxy.ts`.
- Provisioning token RBAC role, global permissions: view/add/change user, view/add/delete group, view/delete authenticated session, view user path, and recovery link creation. It has no rights on providers, applications, flows, roles, tokens, or brands. Object level containment is the guard (Authentik RBAC cannot limit "change user" to learners only). The residual risk is recorded in Consequences.
- Admins should have MFA on their Authentik accounts, so a token that changed an admin's attributes still could not sign in as them.
- PII: names and emails only. They are not sent to logs beyond the user id.

**Configuration required**:
- `AUTHENTIK_URL`, `AUTHENTIK_CLIENT_ID`, `AUTHENTIK_CLIENT_SECRET_FILE`, `AUTHENTIK_PROVISIONING_TOKEN_FILE`, `AUTH_SECRET_FILE`, `ADMIN_ENTRY_PATH` (all named in spec 0001)
- `AUTHENTIK_ADMIN_GROUP`: fixed value `hol-admins` (a constant in code, not env)
- `ADMIN_SESSION_HOURS` (default 2), `LEARNER_SESSION_HOURS` (default 8)
- `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY_FILE` (spec 0001, now also used by resend)
- Setup only: `AUTHENTIK_MASTER_TOKEN` and `APP_URLS` (prod URL plus `http://localhost:3000`) for one run of `npm run authentik:setup`
- Prerequisite (owner): run the setup script, create the provisioning token for the printed service account, add admins to `hol-admins`, and turn on MFA for admins.

**Critical test scenarios**:
- Happy path: an admin from `hol-admins` signs in at `/l0gin` and lands on `/admin`; a dev learner signs in at `/reservations` and lands there with `email_verified_at` set. Verifies **AC-1**, **AC-2**, **AC-7**.
- Failure case: the guard refuses deactivating an admin, writing to the group `hol-admins`, and changing an untagged user outside the saga, each without any Authentik write. Verifies **AC-4**, **AC-9**.
- Failure case: Authentik times out during the guest saga, so no user is left and the message is shown. Verifies **AC-15**, **AC-5**.
- Auth/permission: a learner session calling an admin Server Action gets not authorized; an unknown Authentik user gets no session. Verifies **AC-2**, **AC-10**, **AC-14**.
- Session: an admin session past 2 hours is rejected. Verifies **AC-11**.

## Build plan

Tracer Bullet: get one real admin sign in working through every layer first, then learners, then provisioning.

1. Spike 4 from spec 0001 as a throwaway: Better Auth `genericOAuth` with DB sessions on Next.js 16 against the AWS Authentik, reading `groups` from the profile scope, and setting the session expiry per role in a hook. If it fails, return to `/architect`. Satisfies **AC-1**, **AC-11**.
2. `scripts/authentik-setup.ts` (idempotent; provider, app, `hol-admins`, path, service account plus RBAC role, recovery expiry), satisfies **AC-13**.
3. Migration `0002_better_auth.sql` (the Better Auth tables, the `users.auth_user_id` FK, and `users.set_password_pending`) and `0003_audit_rate_limits.sql`, then `db:codegen`. Satisfies **AC-1**, **AC-8**, **AC-16**.
4. `server/auth/` Better Auth config, the pure `resolveSignIn`, the session create hook (role, expiry, row link, verify), and `require.ts`, plus the admin entry page and `/admin` placeholder. This is the tracer: an admin signs in end to end. Satisfies **AC-1**, **AC-2**, **AC-7**, **AC-10**, **AC-11**, **AC-16**.
5. `/reservations` sign in page, `/auth/error`, sign out with end session, and `X-Robots-Tag` on admin routes in `proxy.ts`. Satisfies **AC-2**, **AC-3**, **AC-12**.
6. Server Action coverage test for `require*`, satisfies **AC-14**.
7. `server/authentik/` client (pinned `@goauthentik/api`, 10 second timeout), `guard.ts`, `findOrCreateLearner`, `issueSetPasswordLink`, and deactivate/reactivate, with guard unit tests. Satisfies **AC-4**, **AC-5**, **AC-6**, **AC-9**, **AC-15**.
8. Wire `findOrCreateLearner` and the set password job into the existing guest saga steps (`server/db/guest-saga.ts`), including the admin email refusal message. Satisfies **AC-5**, **AC-6**, **AC-15**, **AC-16**.
9. `resendSetPassword` action with Turnstile and rate limits, satisfies **AC-8**.
10. Playwright: admin sign in, learner sign in, learner denied `/admin`, sign out. Satisfies **AC-1**, **AC-2**, **AC-12**.

## Consequences

**Positive**:
- One identity source; admin rights live only in Authentik, managed by the owner.
- A leaked provisioning token can't touch providers, flows, or tokens, and the app code won't use it on admins.
- No Authentik SMTP or custom flow needed for verification.

**Negative / tradeoffs**:
- Authentik RBAC can't stop the provisioning token itself from changing an admin user if it is stolen and used outside the app. The guard only protects the app's own calls. Admin MFA and token rotation are the mitigation. This is the recorded fallback the scope asked for.
- Removing an admin takes effect only at their next sign in (up to 2 hours).
- "Verified" means "signed in once". An admin added learner who never signs in can't see lab links.
- The guard re-reads the target from Authentik before every write, which adds one API call per write.

**Neutral**:
- `users.role` is now a cache of Authentik state.
- The `audit_events` and `rate_limits` tables land with this feature.

## Follow-up

- [ ] Owner: enable MFA for every `hol-admins` member, and plan to rotate the provisioning token yearly.
- [ ] Confirm during spike 4 that the deployed Authentik version exposes the `groups` claim in `profile` and that the recovery link API works (spec 0001's 2026.5.6 405 note).
- [ ] Feature 10 uses `deactivateLearner` / `reactivateLearner` and adds the console "resend set password" button; feature 16 owns the email template.
- [ ] Scope: feature 4's done line could note "a learner verifies by first sign in" and "admin removal takes effect within 2 hours".
