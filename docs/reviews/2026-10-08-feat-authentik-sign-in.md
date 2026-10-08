# Review, feat/authentik-sign-in, 2026-10-08

**Reviewed by**: Sonnet 5.5 (author on an earlier model, per the brief)
**Scope**: about 62 files (52 tracked plus 10 untracked, package-lock excluded), branch vs main
**Verdict**: Changes requested

## Summary
This branch adds Authentik sign in through Better Auth, role by group claim, a guarded provisioning client, guest saga wiring, set password resend, sign out that ends Authentik sessions, and a setup script. The design follows spec 0003 closely and the security core is sound: every user write re-reads the target from Authentik, admins and non pod groups are refused, the master token exists only in the setup script, and the app session is deleted before Authentik is called. The headline issue is test coverage: several branching and security relevant paths (deactivate, reactivate, sign in decisions, resend, welcome job, the saga wiring) have no tests at all. There are also a few fail open defaults in the guard and some smaller resilience gaps.

## Major
### 🟠 Security and branching logic with no tests, `server/authentik/learners.ts:201`
**Problem**: Nothing in the test suite calls `deactivateLearner` or `reactivateLearner` (learners.ts:201, 241), `removeFromPodGroup` (groups.ts:42), `guardUserWrite` or `guardGroupWrite` directly with a missing admin group, `validateSignIn` or `onSessionCreate` (sign-in.ts:63, 140), `resendSetPassword` (app/reservations/actions.ts:32), `countHourlyAttempt` (rate-limit.ts:7), `runSendWelcome` (jobs/send-welcome.ts:49), or `bookAsGuest` (booking/guest-booking.ts:34). The pure `resolveSignIn`, the guard predicates, `findOrCreateLearner`, `issueSetPasswordLink`, sign out, and the client wrapper are covered well. The untested pieces are exactly the ones carrying AC-7, AC-8, AC-9, AC-10, AC-11, AC-15 and AC-16 behavior (email verified once, pending flag cleared, per role expiry, admin row creation and linking, deactivated refusal, rate limit buckets, welcome job skipping, saga compensation and audit rows).
**Why it matters**: These are the branches where a regression silently grants a session, skips a deactivation, sends a link to the wrong user, or leaves an orphan Authentik user. The e2e suites need real Authentik and skip in CI, so CI has no guard on them.
**Suggested fix**: Add DB integration tests inside `inRollback` for `validateSignIn` and `onSessionCreate` (first sign in sets `email_verified_at`, never clears it, admin 2h vs learner 8h, no session for deactivated or missing row), `deactivateLearner` and `reactivateLearner` (admin refused with no write, sessions deleted, audit row, partial failure leaves the row active so a retry works), `resendSetPassword` (generic reply in every case, only an eligible learner gets a job, third and fourth attempt limited), `runSendWelcome` (skipped, unavailable, sent), and `bookAsGuest` (compensation on each failure, welcome job only when created, audit rows).

## Minor
### 🟡 Guard fails open on missing groups and a stale admin group id, `server/authentik/guard.ts:74`
**Problem**: `toTarget` turns a missing `groups` field into an empty list, so a response without it reads as "not an admin". `adminGroupUuid` (guard.ts:52 to 70) caches the `hol-admins` uuid for the life of the process. If the owner deletes and recreates the group, the cached id no longer matches any user's groups and every admin passes the check until restart.
**Why it matters**: The guard is the main containment for a powerful token, and both defaults lean the wrong way for a security check. Both cases are unlikely today.
**Suggested fix**: Treat an absent `groups` as a refusal (fail closed). Give the cache a short time to live, or re-resolve the group when a lookup finds it missing, or compare by group name from the expanded groups field.

### 🟡 Sign out can throw instead of landing on the partial page, `server/auth/sign-out.ts:31`
**Problem**: `endAuthentikSessionsFor` only maps the Authentik call result. A throw from `authentik()` (env parse), from the `db()` read, or from `call` re-throwing an unexpected error (client.ts:93) escapes the Server Action after the app session is already deleted.
**Why it matters**: AC-12 promises `signout_partial` whenever the Authentik step fails. The user would get a 500 page instead, with no hint they are signed out of HOL.
**Suggested fix**: Wrap the body in try and catch, log, and return false. Keep the app session delete first as it is now.

### 🟡 Session listing is not paginated, `server/authentik/sessions.ts:13`
**Problem**: `pageSize: 100` with no follow up page, and a row with no uuid is silently skipped and still counted as ended.
**Why it matters**: A user with more than 100 Authentik sessions keeps the rest after sign out or deactivation. Deactivation still blocks new sign ins through `is_active`, but old Authentik sessions would remain for other apps.
**Suggested fix**: Loop while the response has a next page, and report `unavailable` if a row has no uuid.

### 🟡 Orphan Authentik user between create and record, `server/booking/guest-booking.ts:59`
**Problem**: If the process or DB fails after `findOrCreateLearner` creates the Authentik user but before `recordAuthentikUser` commits, compensation has no pk to delete. On the next booking attempt the user is found as an already tagged user (`created: false`), so no welcome job is queued and `set_password_pending` stays false, which also blocks resend. I am not sure whether the spec 0002 sweeper covers this window.
**Why it matters**: That learner has an account they can never set a password for through the app.
**Suggested fix**: Record intent (pending saga flag with the Authentik username) before the create call, or let the reuse path set `set_password_pending` and queue the welcome job when the Authentik user has never had a sign in.

### 🟡 Admin row insert can hit the unique email constraint, `server/auth/sign-in.ts:85`
**Problem**: A new admin is inserted when no row matches by pk or by an unlinked email. If a linked learner row already has that email (a different Authentik user), the insert violates the unique email index and throws out of `validateUserInfo`.
**Why it matters**: The admin sees a generic failure, and nothing is audited as `admin.sign_in_refused`. AC-10 says this case is refused and audited.
**Suggested fix**: Look up by email without the `authentik_user_pk is null` filter for admin claims, and route a linked row to `refused_learner_is_admin`.

### 🟡 Resend counts attempts before Turnstile and shares an "unknown" IP bucket, `app/reservations/actions.ts:43`
**Problem**: Anyone can burn a victim's 3 per hour email bucket without a valid token, and when `cf-connecting-ip` is missing every caller shares `resend:ip:unknown`. Also a failed or unavailable Turnstile check returns the "we've sent a new link" message even though nothing was sent.
**Why it matters**: A cheap denial of service against one learner's resend, and a global lockout when the header is absent. The "every attempt counts" rule is in the spec, so this is a tradeoff, not a deviation.
**Suggested fix**: Verify Turnstile before counting the email bucket (keep the IP bucket first), and decide what the unknown IP case should do (probably refuse). Consider a distinct message for a failed challenge.

### 🟡 Server Action coverage test is easy to bypass, `tests/server-actions-require.test.ts:30`
**Problem**: The scan only sees `export async function`. `export const x = async () => ...` or an inline `"use server"` function is invisible, and the check is a regex for `await requireAdmin()` anywhere in the body, even after a write or inside a comment.
**Why it matters**: AC-14 is meant to be a hard gate, and this one can pass while an action is unprotected.
**Suggested fix**: Also match exported arrow functions, fail on any exported non async function in a `use server` file, and require the `require*` call to be the first awaited statement.

### 🟡 Tag step skips a key that is present but wrong, `server/authentik/learners.ts:119`
**Problem**: `!(key in attributes)` treats `hol_learner: false` or a string as already tagged, so no tag is written and every later guarded write is refused as `not_learner`.
**Why it matters**: A reused account with odd existing attributes books fine but can never be deactivated or sent a link. Rare.
**Suggested fix**: Compare values, or refuse the booking when `hol_learner` exists but is not `true`.

### 🟡 Case sensitive lookup may miss a mixed case stored email, `server/authentik/learners.ts:54`
**Problem**: Authentik's `email` and `username` list filters are most likely exact match. A stored `Mixed@Case.test` with a different username is not found by the lowercased query, so a second Authentik user would be created for the same person. The tests use a fake that matches case insensitively, so this is not proven either way.
**Why it matters**: Duplicate identities for one person, which AC-5 tries to prevent.
**Suggested fix**: Check the real filter behavior against the deployed Authentik, and if exact, add a case insensitive search (`search` parameter) and keep the post filter.

### 🟡 `rate_limits` has no cleanup, `db/migrations/0003_audit_rate_limits.sql:40`
**Problem**: One row per bucket per hour, never deleted.
**Why it matters**: Slow unbounded growth, mostly from the IP and email buckets.
**Suggested fix**: Add a periodic delete of old windows in the worker, or note it as a follow up in the spec.

### 🟡 Shared constants defined in two places, `server/authentik/learners.ts:7`
**Problem**: Server code imports `LEARNER_PATH` from `@/scripts/authentik-setup-plan`, and `ADMIN_GROUP` is declared in both `scripts/authentik-setup-plan.ts:7` and `server/auth/resolve-sign-in.ts:5`.
**Why it matters**: A rename in one place silently breaks the guard or the setup script. Runtime code reaching into `scripts/` also goes against the layout rule.
**Suggested fix**: Put the shared constants in `lib/` and import them from both sides.

## Nits
- ⚪ `server/authentik/client.ts:44`, a retried 5xx response body is dropped without `res.body?.cancel()`.
- ⚪ `server/authentik/sessions.ts:26`, `s.uuid ?? ""` is dead after the filter; narrow the type instead.
- ⚪ `server/authentik/learners.ts:180`, `learnerRow` returns `"not_found"` typed as part of `StatusChangeError` only through `AuthentikFailure`, which reads as an Authentik result. Give it its own error name.
- ⚪ `e2e/authentik.ts:19`, the Authentik host and test usernames are hard coded; read them from env.
- ⚪ `scripts/authentik-setup.ts:56`, reads `process.env` directly (reasonable, since the master token must stay out of `server/env.ts`); a one line comment in AGENTS rules or the file header would stop a reviewer flagging it.

## Strengths
- Guard design is clean: pure predicates (`checkUserWrite`, `checkGroupWrite`) split from the I/O wrapper, the target is re-read from Authentik on every write, and `issueSetPasswordLink` and `deleteSagaLearner` both go through it, with tests proving no write happens on a refusal.
- Sign out order is right (app session first, Authentik second), the result maps to a plain redirect, and there are unit tests for the failure path.
- The master token is genuinely absent from runtime: `server/env.ts` has no field for it, and the runtime client uses only the provisioning token.
- The client wrapper has one shared deadline, retries only reads, and never repeats a write.
- Errors page shows only fixed messages (no reflected input) and gives no admin hints; sign in decisions use exhaustive `never` switches.

## Test coverage
Covered well: `resolveSignIn`, guard predicates, guarded Authentik writes, `findOrCreateLearner` cases, client timeout and retry, sign out and its failure path, `signInWithSso`, error page mapping, the setup plan, and Playwright suites for sign in and learner isolation (skipped without secrets, so not run in CI). Not covered: deactivate and reactivate, `removeFromPodGroup`, `validateSignIn` and `onSessionCreate` DB behavior, `resendSetPassword`, `countHourlyAttempt`, `runSendWelcome`, `bookAsGuest` and its compensation, `require.ts` role checks, and `proxy.ts`. See the Major finding.
