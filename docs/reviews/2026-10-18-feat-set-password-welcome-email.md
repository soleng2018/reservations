# Review, feat/set-password-welcome-email (feature 16, spec 0014), 2026-10-18

**Reviewed by**: Sonnet 5.5 (author on Opus, a different model)
**Scope**: 49 files, branch vs base 7cc3499 (feature 16 only: commits 47036ac and 0e5006b plus the working tree and the untracked spec folder)
**Verdict**: Approve with nits

## Summary

This feature adds the app's own single use set password link. The worker mails a 43 character token and stores only its sha256. The click page is a read only GET. A Server Action takes the locks, asks Authentik for a 10 minute recovery link, and ends the clicked link and its siblings. The security core is sound: tokens come from `randomBytes(32)`, only a hash is stored, lookup is by a unique indexed hash (so no string compare to time), expiry uses the DB clock, an email change ends links in the same transaction under the user lock, and the raw token never reaches a row, payload, audit entry, or log. I found no blockers or majors. The minors are two edge cases (a possible deadlock and a resend swallowed after a stale job), a missing concurrency test, and some small items.

## Minor

### 🟡 Two live links of one user clicked at the same moment can deadlock, `server/auth/set-password-links.ts:114` and `server/auth/start-set-password.ts:51`
**Problem**: The click locks the user `FOR SHARE`, then only its own link `FOR UPDATE`. Then `endClickedLink` updates every other live link of that user. If a learner holds two live links (first email plus a resend) and two clicks race, click A holds link A and wants link B, while click B holds link B and wants link A. Postgres aborts one with a deadlock error.
**Why it matters**: The aborted click throws a non Refusal error, so the learner sees a generic 500 instead of a Dead or retry view. The spec's claim that the lock order never deadlocks only covers user versus link, not link versus link. It needs a double open from two tabs or devices, so it is rare, and the failure is safe (nothing is half done, the other click wins).
**Suggested fix**: In the locked read, also lock all live links of the user in a fixed order (for example `order by id for update`) before checking, or catch the deadlock error code and map it to `dead`. Add a test for the race.

### 🟡 A resend queued during a long outage is swallowed by the stale suppressed row, `server/jobs/send-welcome.ts:77`
**Problem**: `alreadyCovered` counts `suppressed` rows with `created_at >= job.createdAt`. When the original job is over 72 hours old, the handler writes a `suppressed` stale row stamped at processing time. A resend job queued earlier than that moment (during the outage) is processed next, finds that row (same address, newer than its own `createdAt`), and finishes `done` with no email.
**Why it matters**: The admin used Resend to fix the outage and the learner still gets nothing. The console shows only the stale note, and the admin has to resend a second time. It needs an outage longer than 72 hours, so it is uncommon.
**Suggested fix**: Do not let the stale row cover other jobs, for example by excluding the stale reason text, or by judging coverage by the job's `created_at` only for `sent` rows. Add a test for stale original followed by a fresh resend.

### 🟡 No test for the lock order or concurrency scenario the spec lists, `server/auth/start-set-password.test.ts`
**Problem**: The spec's "Lock order" critical scenario (a click and an email change at the same moment, both finish) has no test. Tests run inside `inRollback`, which makes true concurrency hard, but nothing covers even the sequential interleavings (email change first, then click gives Dead, which the other tests nearly show).
**Why it matters**: This is the security relevant race that makes revocation real, and the deadlock above shows the ordering is not fully proven.
**Suggested fix**: Add one test that commits to a scratch schema or uses two connections, or record in `verify.md` that it was checked by hand.

### 🟡 The DB transaction and the user share lock are held across two network calls, `server/auth/start-set-password.ts:48`
**Problem**: The Authentik request and `signInSocial` run inside the transaction while `users` is locked `FOR SHARE`. The spec chose this on purpose (lock first pattern), but I found no timeout on the Authentik call in this path.
**Why it matters**: A slow Authentik holds a pooled connection and blocks an admin edit of that learner (`FOR UPDATE`) until it returns. Misuse by a script is limited by the miss limit only for dead tokens, not live ones.
**Suggested fix**: Confirm the Authentik client has a request timeout and note it in the action comment. No design change needed.

## Nits

- ⚪ `server/email/compose.ts:206`, the spec says "no attachment" but the welcome message embeds the logo as an inline `cid` image, like the booking emails. Fine in practice, but make the spec wording say "no downloadable attachment" so tests and spec agree.
- ⚪ `app/set-password/[token]/page.tsx:25`, `turnstileEnv()` is read for the Live view too, where the site key is not used. Harmless, but it makes the Live page fail if the Turnstile env is missing.
- ⚪ `server/auth/set-password-links.ts:35`, the `lock` flag does the owner lookup unlocked and then rereads by hash; a short comment saying the hash is immutable (so the unlocked owner read is safe) would help the next reader.
- ⚪ `server/jobs/AGENTS.md`, `server/authentik/AGENTS.md`, and the `HANDLERS` comment are listed as stale in the spec follow up; remember `/sync`.

## Strengths

- Token handling is careful: 256 bit random token, sha256 at rest, unique hash index, one shared pure predicate (`linkView`) used by the page and the action, DB clock for expiry, and `referrer: no-referrer`.
- The click is a POST Server Action behind a read only GET, so mail scanners cannot burn a link. Only misses count toward the IP limit, so classrooms behind one NAT are not blocked.
- The handler writes nothing before the Gmail call, which matches the runner's commit on every outcome, and it forces the Ops BCC off for welcome mail.
- Email change revocation runs under the user lock before the new job is queued, with a DB time based job key so X to Y to X to Y still sends.
- Authentik writes stay inside the documented provisioning scope (a new login stage and binding on the app owned `hol-recovery` flow, dry run first), and `issueSetPasswordLink` stays guarded.
- The `startSetPassword` action is on the public allow list and scanned by a test. The `checkLists` entry matches the new CHECK list.

## Test coverage

Strong. Unit and DB tests cover the pure view predicate, token shape, hash only storage, email change revocation and its backstop, the purge (31 days goes, 29 stays), every Gmail outcome, the stale and no `appUrl` skips, routing with no BCC, one send per user, the Authentik unavailable and guard refusal paths, the origin mismatch, the miss limit, the leak scans for rows, payload, audit, and logs, and a Playwright flow. The gap is the concurrency scenario noted above and the stale row then resend case.
