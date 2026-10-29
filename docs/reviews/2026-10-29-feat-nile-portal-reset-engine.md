# Review, feat/nile-portal-reset-engine (merged to main), 2026-10-29

**Reviewed by**: claude-opus-5-5 (author on a different session's model)
**Scope**: 65 files plus the untracked `server/portal-engine/sign-in-launch.test.ts`, branch equivalent `600f9c6~1..HEAD` vs main (engine, `lib/portal-reset`, worker, migration 0019; docs skipped)
**Verdict**: Changes requested

## Summary

The change adds the Nile Portal reset engine: queueing runs at lab end, claiming them with a lease, a headless browser sign in as a per workshop automation account, a step interpreter with a single guarded call choke point, a discovery pass, run records, audit rows, and the report email. The code is careful and well commented, the pure rules are cleanly split into `lib/portal-reset/`, secrets live in a `Secret` wrapper, and the database is the clock throughout. The headline problems are in the run lifecycle around the edges: the lease has no owner and is not renewed during the two longest phases (sign in and discovery collection), so a second lane can take over a run that is still going; a held run is killed by the 2 hour cap the spec says it does not have; a second 401 during the tenant check escapes `executeRun` and leaks a Chromium; and the hard guards do not look at ids carried in a query string.

## Major

### 🟠 The lease has no owner and is not renewed during sign in or discovery collection, `server/portal-engine/claim.ts:104`
**Problem**: `stopCheck` renews the lease with `where r.id = $1 and r.state = 'running'`, and returns `lost` only when the state is no longer `running`. There is no owner token (lane id or claim id) on the row. The lease is 90 seconds, but two stretches of a run make no stop check at all: the sign in in `run.ts:171` (`connect` can take far over 90 seconds: `goto` 60 s, selector 30 s, Authentik redirect 60 s, password step 30 s, leave 60 s, landing 60 s, token wait 30 s, plus a 20 s retry and a second attempt), and `collectAll` in `discovery.ts:231` (up to 20 pages, each up to 30 s domcontentloaded, 30 s networkidle, and 3 s settle, before the first delete calls `beforeWrite`). When the lease runs out, the other lane (`PORTAL_RESET_LANES` defaults to 2) claims the run as an expired lease, increments `resumes`, sets a new password, and starts the same run. The first lane's next `stopCheck` still sees `state = 'running'`, renews the lease, and answers `go`, so both lanes work the same tenant at once.
**Why it matters**: Two runs delete on one tenant concurrently, append items with colliding `seq` values (`report.ts:54` reads `max(seq)` then inserts, so one `appendItems` fails on `portal_reset_run_items_seq_uq` and throws out of the run), each takeover burns one of the 3 resumes toward `crashed`, and only one of the two finishes counts. The live verify saw 6 discovery pages settle quickly, so this has not bitten yet, but one slow portal page or one sign in retry is enough.
**Suggested fix**: Store a claim token (a uuid set at each claim) on the run and make `stopCheck`, `saveProgress`, `releaseRun`, `appendItems`, and `finishRunIn` match on it, so a lane that lost its lease gets `lost`. Renew the lease (one stop check) between discovery pages and around the sign in, or run a lease heartbeat while a lane holds a run. Add a test where a second claim takes an expired lease while the first lane is still running and assert the first lane stops.

### 🟠 A held run is aborted by the 2 hour cap, which AC-14 says it does not have, `server/portal-engine/claim.ts:119`
**Problem**: `settleHeldRuns` puts a held run back to `queued` after 30 minutes with no lab, and the claim then runs `stopCheck`, which computes `past_cap` from `lab_ended_at + HARD_CAP` with no regard to the run having been held. A run held at about 6 minutes after the lab ended gets retries at about 36, 66, and 96 minutes; the next retry (about 126 minutes) is aborted `deadline` before it signs in.
**Why it matters**: AC-14 says "A held run has no 2 hour cap, but ends when the lab starts". An Authentik outage longer than about 2 hours (or an `idp_rejected` the owner fixes after 2 hours) leaves the tenant dirty with a `deadline` email instead of resetting it when the cause clears. The verify run of AC-14 requeued after 31 minutes, inside the cap, so it did not catch this.
**Suggested fix**: Exempt runs that were ever held from the cap (for example a `held_at` or `was_held` column, or measure the cap from the last requeue), and add a DB test that holds a run, moves `lab_ended_at` back past 2 hours, settles, claims, and expects a sign in attempt rather than `deadline`.

### 🟠 A second 401 during the tenant check escapes `executeRun` and leaks the browser, `server/portal-engine/connect.ts:165`
**Problem**: `withResignIn` throws `SessionLost` on a second 401 or on a refused fresh sign in. `connect` calls `checkTenant` through that wrapper (`connect.ts:195`) and does not catch it, and `executeRun` calls `deps.signIn(run)` at `run.ts:171`, outside its `try`/`finally`. The exception therefore leaves `executeRun` with the Chromium of the current session still open (no `close` runs), the run left `running` with a live lease, no `sign_in_failed` audit row, and no email. The lane logs `SessionLost` and the run is resumed after the lease expires, repeating up to 3 times, then ends `crashed`. The same path applies to any unexpected throw inside `connect` after `signIn` returned a browser (for example a thrown fetch inside `contextFetch`).
**Why it matters**: Each attempt leaves a Chromium process behind in the worker container, the owner gets a misleading `crashed` email much later instead of an immediate sign in failure (AC-15, AC-17), and the run burns its resumes.
**Suggested fix**: In `connect`, wrap the tenant check in a try that closes the portal and maps `SessionLost` to `err({ kind: "sign_in", reason })`; or move the `signIn` call inside the `try` of `executeRun` so the existing `SessionLost` branch and a `finally` close cover it. Add a connect test where both tenant reads answer 401.

### 🟠 The hard guards ignore ids carried in a query string, `server/portal-engine/guards.ts:130`
**Problem**: `hitOf` normalises the path with `normalizePortalRoute`, which drops the query, then looks for protected ids only in the path segments after the prefix and in the body leaves. A `DELETE /api/v1/settings/ssids?id=<protected id>` (or a batch `?ids=a,b`) falls under the guard prefix with an empty `rest` and no body, so it is neither skipped by `isGuardedWrite` nor refused by `guardedPortal`. The portal does use query parameters on writes (the branding restore is `DELETE /api/v1/cloud-profile/value?profile_name=...`), and steps are owner edited data.
**Why it matters**: AC-26 promises that any `DELETE` or `PUT` under a guard's prefix that holds a protected id is refused "whatever step, part, or discovered route made it". This is the last line of defence that keeps the protected SSID, Nile RADIUS, and Nile DHCP from being deleted; a step written with a query style delete passes straight through it.
**Suggested fix**: Include the decoded query values (split on `,` as well) in the ids `hitOf` tests, for both the interpreter's skip and the choke point refusal, and add a guards test with the protected id in the query.

## Minor

### 🟡 Runs are queued for a testbed with no `portal_url`, `server/portal-engine/queue.ts:131`
**Problem**: Both `queuePortalReset` and `queueEndedResets` (`queue.ts:155`) require `t.domain is not null` but not `t.portal_url is not null`, while AC-2 requires both.
**Why it matters**: A testbed with a domain but no portal address gets a run at every lab end that aborts `testbed_unavailable` and emails the owner each time.
**Suggested fix**: Add `and t.portal_url is not null` to both inserts (AC-7 still covers a URL that is removed after queueing).

### 🟡 A refused re sign in after a 401 ends the run instead of holding it, `server/portal-engine/connect.ts:168`
**Problem**: When the fresh sign in after a 401 fails with `idp_rejected` or `credential_failed`, `SessionLost` carries that reason and `run.ts:304` ends the run `aborted`, while AC-14 says those two reasons hold the run.
**Suggested fix**: In the `SessionLost` branch, call `holdRun` when `holdsRun(e.signInReason)`.

### 🟡 Two lanes can race the claim for the same testbed and one throws, `server/portal-engine/claim.ts:53`
**Problem**: Lane A locks run X and is about to commit `running`; lane B skips X (locked), still sees no committed running run for the testbed, picks queued run Y, and its update then waits on and fails against `portal_reset_runs_one_running_uq`. The error goes to the lane's catch, which logs the error name and idles 15 seconds.
**Suggested fix**: Catch the unique violation in `claimDueRun` and return `undefined`, or take a per testbed advisory lock in the claim transaction.

### 🟡 The discovery time budget is checked only between pages, `server/portal-engine/discovery.ts:246`
**Problem**: `DISCOVERY_BUDGET` stops page visits but not the delete and reread loop over candidates, so AC-38's "stops after 5 minutes" holds only for collection.
**Suggested fix**: Check `elapsedMs()` before each candidate and count the rest as skipped for time.

### 🟡 `newContext` sits outside the collector's try, `server/portal-engine/discovery.ts:65`
**Problem**: If the browser was closed (for example after a re sign in closed the old session) `browser.newContext` throws out of `runDiscovery` and the whole run ends through the lane catch, instead of counting the page as timed out.
**Suggested fix**: Move the context creation inside the `try` and return `"timeout"`.

### 🟡 Any non timeout error on the Authentik pages is read as `idp_rejected`, `server/portal-engine/sign-in.ts:149`
**Problem**: A dropped connection or a detached frame during the uid or password step becomes `idp_rejected`, which holds the run for 30 minutes and emails at once, rather than a transient reason that retries after 20 seconds.
**Suggested fix**: Map navigation and network errors on these steps to `portal_unreachable`, keeping `idp_rejected` for "still on Authentik after the password".

### 🟡 Redaction misses base64 and bare host names, `lib/portal-reset/redact.ts:119`
**Problem**: `LONG_RUN` excludes `+`, `/`, and `=`, so a PEM body or base64 secret echoed in a portal message breaks into short runs that survive; a host name without a scheme (`radius.example.com`) also survives. AC-30 lists private keys and certificates among the values that must never reach a record or email.
**Suggested fix**: Add a base64 pattern (`[A-Za-z0-9+/=]{24,}`) and a PEM block pattern, and consider a bare host pattern.

### 🟡 Discovered routes get no second pass, `server/portal-engine/run.ts:254`
**Problem**: AC-19 step 6 says the second pass covers failed steps "and discovered routes", but discovery only sets `discoveryFailed` and its own inline retry; phases 3 and 4 never revisit a discovered route.
**Suggested fix**: Either record the decision in the spec, or keep the accepted convention routes in progress and reread them in phase 4.

## Nits
- ⚪ `server/portal-engine/report.ts:161`, `coalesce(..., sign_in_reason)` keeps a held attempt's sign in reason on a later `lab_started` or `done` finish, so the Recent resets page can show a sign in reason on a run that did not fail sign in.
- ⚪ `server/portal-engine/report.ts:250`, every held retry that fails again writes another `portal_reset.sign_in_failed` row; fine by AC-15's wording, but an outage of hours produces one row per 30 minutes per testbed.
- ⚪ `server/portal-engine/guards.ts:71`, the comment line runs past the wrap width the rest of the file keeps.
- ⚪ `server/portal-engine/run.ts:168`, `unsafeDeleteOrder` reuses `invalid_list`, which the email explains as "a step could not be read"; a clearer reason text would help the owner.

## Strengths
- The single call choke point is genuinely single: `guardedPortal` wraps the real client for steps and discovery, the client refuses off origin, non `/api/`, and denied paths before sending, never follows redirects, caps the body at 5 MB, and keeps the headers in a `Secret` revealed only there.
- Finishing a run is one transaction that writes the state, counts read back from the saved items, the audit rows, and the report job, with `state in ('running','held')` making a double finish impossible. Item records are flushed after each step, so a crash keeps them.
- The guard fixes found live (parent protected only as itself, `allowPut`) are explained in place and now tested with the guards on across the 13 steps.
- The SIGTERM fix (`handleSIGINT/TERM/HUP: false`) is small, correct, and locked by the new untracked `sign-in-launch.test.ts`.

## Test coverage
Coverage is broad: pure rules, the fake portal runs of all 13 steps with guards, connect against the fake Authentik, the held state, dry run, discovery filters, purge, and DB tests inside `inRollback`. Missing: a lease takeover while the first lane is still alive (the existing resume test only claims an expired lease with no live owner); a held run retried after the 2 hour cap; two 401s during the tenant check; a guarded id in a query string; the claim race between two lanes for one testbed. The untracked `sign-in-launch.test.ts` is sound and should be committed.

## Resolution (2026-10-29, branch feat/portal-reset-review-fixes)

The four majors are fixed, each with a regression test. The 8 minors and 4 nits are left open.

- Lease: `keepingLease` in `server/portal-engine/claim.ts` renews the lease on a timer while the sign in and the discovery pass run, so a second lane no longer takes over a live run. The lease still has no owner token; a takeover can now only follow a dead process.
- Held run cap: `stopCheck` skips the 2 hour cap for a run that was ever held (`sign_in_reason` is set), as AC-14 says.
- Lost session in the tenant check: `connect` turns a `SessionLost` into a sign in failure and closes the browser first.
- Query string: `hitOf` in `server/portal-engine/guards.ts` reads ids from the query string too, so `?id=<protected>` is refused.
