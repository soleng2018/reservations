# Review, feat/admin-users, 2026-10-11

**Reviewed by**: Sonnet 5.5 (author on a different model)
**Scope**: 38 files, branch vs main (focus range: git diff cd56ef1, spec 0008)
**Verdict**: Approve with nits

## Summary
This branch adds the admin Users list and detail pages, the add saga with its sweeper, edit with Authentik sync, deactivate and reactivate with booking cancellation, a single reservation cancel, and the admin timezone sync. The concurrency design holds up. Every state change locks the user row first and rechecks its preconditions, and the guest saga also locks that row and checks for an active status, so a deactivation cannot race a new booking. Every action and page calls requireAdmin and every Authentik write goes through the guard. I found no blockers or majors, only minors around partial failure and leftovers.

## Minor
### 🟡 Row lock held across many Authentik calls, `server/authentik/learners.ts:247`
**Problem**: deactivateLearner holds the user row lock and one pooled DB connection while it makes the guard read, the patch, the session list, and one destroy per session. Each call can take up to the 10 second client timeout.
**Why it matters**: The spec accepts the lock first pattern. In the worst case a slow Authentik blocks the learner's sign in and a guest booking for tens of seconds, and it can tie up pool connections if an admin retries.
**Suggested fix**: Accept it as is, or add a short statement or lock timeout so a stuck call fails fast. Note it in the spec consequences.

### 🟡 Deactivate can leave Authentik inactive while the app says Active, `server/authentik/learners.ts:262`
**Problem**: setActive(false) runs before endSessionsOf. If ending sessions fails, the Refusal rolls back the DB but Authentik stays inactive.
**Why it matters**: The learner is blocked at sign in but the console shows Active with "Unavailable" as the error. A retry converges, so it is not data loss, but the state is misleading until then.
**Suggested fix**: Tell the admin that a retry will finish it, or have reactivate and deactivate treat the already inactive account as a normal case (they already do). A short note in the error text would be enough.

### 🟡 Edit pushes to Authentik before the DB write, `server/users/learners.ts:468`
**Problem**: If the app update or the audit insert fails for a reason other than the duplicate email constraint, Authentik already holds the new name, email, and username while the app row keeps the old values.
**Why it matters**: The comment covers the duplicate race, but not other failures. The welcome job then reads the old app email. A second save converges it, so this is a small window.
**Suggested fix**: Document that a repeat save converges for every failure, not only the duplicate case, and add one test for a failed commit followed by a retry.

### 🟡 A case only email change sends another welcome email, `server/users/learners.ts:455`
**Problem**: emailChanged compares with `!==`, so changing A@x.com to a@x.com counts as a change and queues a new welcome job. The Authentik username does not change.
**Why it matters**: A learner who is still waiting gets an extra set password email for no real change.
**Suggested fix**: Compare lowercased emails to decide whether to queue the welcome job. Keep the plain compare for the stored value.

### 🟡 Add saga leaves a created Authentik user if the row vanished, `server/users/learners.ts:312`
**Problem**: If the sweeper (or anything else) deletes the pk less row before the final transaction, it throws "vanished". The catch finds nothing to delete, so the Authentik user the saga created is not removed.
**Why it matters**: It needs a saga that takes over 10 minutes, so it is very rare. The orphan is reused on the next add of that email, so it converges.
**Suggested fix**: Treat the vanished row as a cleanup case: when `created` is true, still call deleteSagaLearner.

### 🟡 Deactivate does not require a pk, `server/authentik/learners.ts:207`
**Problem**: lockLearnerRow only checks the role. A crafted id of a hidden row that is still being added (no pk) can be marked deactivated, which skips Authentik entirely.
**Why it matters**: Update and the console pages hide such rows, but this path does not. The add saga would then finish a learner who is already deactivated in the app but active in Authentik. Needs a UUID that no page shows, so it is low risk.
**Suggested fix**: Make deactivate refuse a row with no pk, as lockLearner in users/learners.ts already does.

## Nits
- ⚪ `app/admin/users/actions.ts:178`, checkDeactivate declares an "unavailable" error it never returns; the client branch for it is dead.
- ⚪ `components/admin/learner-status-actions.tsx:155`, no spacing between the dialog description and "These reservations will be cancelled:" (the verify run saw it too).
- ⚪ `server/users/learners.ts:70`, the verify note about no tiebreaker is already handled: `orderBy("u.id")` follows `lower(u.name)`. Nothing to do.
- ⚪ The worker "skipped group (not_found)" log every tick is old data and not part of this diff.
- ⚪ A deactivated learner seeing Authentik's generic "Invalid password" is Authentik behaviour and not fixable in this diff.

## Strengths
- Lock first with a Refusal that rolls back everything, and checks repeated inside the statements (HAS_NO_BOOKINGS in every cleanup delete and the sweeper, cancel guarded by status, end time, and version).
- Deactivation cancels bookings, ends both Authentik and app sessions, and is audited per booking in one transaction; the reconciler also ignores deactivated users as a backstop.
- Add saga cleanup is careful: it never deletes a row a guest booking picked up, and only removes an Authentik user it created.
- Strong test coverage: DB backed tests inside inRollback, the fake Authentik asserting no writes on refusal, an actions test guarding requireAdmin, and an e2e happy path.

## Test coverage
Good. Learner functions, the Authentik status and identity changes, both sweepers, the reconciler change, the admin timezone, and the action guards all have tests. Gaps: no test for a failed app commit after a successful Authentik push on edit, none for the case only email change, and none for the "row vanished before pk" path in the add saga.
