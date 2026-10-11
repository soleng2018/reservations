# Review, feat/admin-api-keys, 2026-10-10

**Reviewed by**: Claude Sonnet 5.5 (author on Opus, confirmed by the engineer)
**Scope**: 36 files, branch vs main (server/db/types.ts skimmed only; DB-backed Vitest and Playwright not run by the reviewer)
**Verdict**: Approve with nits

## Summary
Adds the AES-256-GCM secrets module, a lazy keyring env, the `api_keys` migration, and the full admin API Keys screen (list, add, edit, delete) on the Testbed Types patterns. The secret path is carefully closed: no query selects the ciphertext outside the writer, results and props carry fixed strings only, audit metadata is built from an allow-list of fields, and unmapped DB errors are flattened. Crypto matches AC-7 (random 12-byte IV, pinned 16-byte tag, row-bound AAD, strict base64url). Typecheck passes, and the non-DB Vitest suites (261 tests) pass. Only small observability and hardening items remain.

## Minor
### 🟡 Flattened write errors lose all diagnostics, `server/catalog/api-keys.ts:107` (also :198, :236)
**Problem**: Every non-duplicate DB failure is rethrown as `new Error("api key write failed")` with no cause and no log.
**Why it matters**: A connection drop, an FK problem, a CHECK violation, or a Zod `ApiKeyType.parse` failure all look identical in prod logs. The spec only needs the row detail (which may hold the ciphertext) kept out, not the SQLSTATE.
**Suggested fix**: Log only non-sensitive fields before throwing (the Postgres `code` and `constraint`, or the error class name), never `detail`, `message`, or `cause`. Keep the thrown message fixed.

### 🟡 Base URL fragment is not refused, `lib/catalog-input.ts:~52`
**Problem**: AC-3 blocks userinfo and query strings so no secret hides in a displayed and audited field, but `https://host/path#token` passes and lands in the list, the audit metadata, and the DataTable search text.
**Why it matters**: It is the same leak class the rule exists for, through the one URL part left open.
**Suggested fix**: Add a refine for a non-empty `hash` ("Remove the fragment from the URL."), with a test; update AC-3 to match.

## Nits
- ⚪ `server/catalog/api-keys.ts:91`, `onConflict(oc => oc.doNothing())` has no target, so a PK collision would also surface as "duplicate_name". Target `lower(name)` or accept it knowingly.
- ⚪ `app/admin/api-keys/page.tsx:41`, `console.error` runs on every page load while the keyring is broken. It is safe (no key printed) but noisy; fine to leave.
- ⚪ `server/catalog/api-keys.ts:154`, `apiKeyBlockers` reads testbeds without a lock. This is the accepted AC-5 window until feature 9 locks the key `FOR SHARE` (tracked in Follow-up).

## Strengths
- Defence in depth on secret leakage: the explicit column list plus a compiled-SQL test, the source scan for `secret_ciphertext`, a Playwright canary scan, fixed Zod messages, and `changedFields` only comparing listed keys.
- Crypto is correct and well tested: pinned IV and tag lengths, AAD bound to table, column, and row, strict base64url, and flipped-decoded-byte tests (not last-character flips). Plain-text secrets can never match the `like 'v1:%'` CHECK by accident.
- Env handling is lazy, does not touch `next build`, never echoes key material (canonical base64 check, ids truncated), and caches only a valid keyring.
- Faithful reuse of the Testbed Types lock, blocker, soft-delete, and audit-in-transaction pattern. Exhaustive `never` switches, `requireAdmin()` first in every action, and `z.uuid()` on bound ids.

## Test coverage
Strong. Unit tests cover crypto edge cases, the keyring env failure modes, and keygen (run for real in an empty cwd). DB integration tests run inside `inRollback` and cover create, update (keep or replace, no-op, audit rows, not_found, type_in_use), delete (blockers, race between check and remove), and the forced unmapped-error path. Action tests cover the learner refusal, the missing keyring, and bad ids; Playwright covers the canary scan. Gaps: nothing covers a base URL fragment (see above), and the DB and e2e suites were not executed in this review.
