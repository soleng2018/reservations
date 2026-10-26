# Verify: Cleanup hook for labs that end early · spec 0021

Run on 2026-10-26 by `/check verify`. A ticked step was run and passed. An unticked step was not run or could not be.

## UI / manual

Admin console, API Keys page (dev server on the LAN IP, observed by the owner):

- [x] Add API key, choose type `CLEANUP` → the second field is labelled "Signing secret" with the note "At least 16 characters"   → AC-1
- [x] Save an empty form → field errors for name, https URL, and key   → AC-1
- [x] Base URL `http://…` → "Enter an https:// URL."   → AC-1
- [x] Base URL `https://user:pw@example.invalid/hook` → "Remove credentials from the URL."   → AC-1
- [x] Base URL ending in `#frag` → "Remove the # part from the URL."   → AC-1
- [x] Secret shorter than 16 characters → "Use at least 16 characters."   → AC-1
- [x] Save a valid key (https URL, 16+ character secret) → the key is created   → AC-1
- [x] The list row shows type `CLEANUP`, the host only with the path hidden (`https://example.invalid/…`), and a masked key value   → AC-1, AC-9
- [x] Add a second `CLEANUP` key → "Only one Cleanup key can exist. Edit the existing one."   → AC-1
- [x] Edit the key → Base URL is empty with only the host in its placeholder, and the secret box says "Leave blank to keep the current key."   → AC-1, AC-9
- [ ] Delete the test key when done (the owner removes it, then confirm the row is gone)   → AC-1
- [ ] After a real hook failure, the key row shows a "Needs attention" badge and the failed call line   → AC-7
- [ ] Sign in as a learner, cancel and reschedule a booking → the screens and results look the same as before this spec   → AC-11

## Commands

- [x] `npm run db:migrate` → "nothing to apply" (migration 0017 is live)   → AC-1, AC-7, AC-8
- [x] Query the live schema → index `api_keys_one_cleanup_uq`, column `api_keys.cleanup_failed_at`, `CLEANUP` in `api_keys_type_check`, and `cleanup_notify` in `jobs_kind_check` all exist   → AC-1, AC-7
- [x] `npx vitest run` → 126 files, 1980 tests, all pass against the real database (cancel and reschedule queueing, signed POST with a real local receiver, retries, stale cutoff, failure audit and guarded badge mark, jobs step never claims the hook)   → AC-2 to AC-8, AC-10, AC-12, AC-13
- [x] `npx tsc --noEmit` and `npm run lint` → no errors   → all
- [x] `tests/secret-column-scan.test.ts` and `tests/cleanup-hook-scan.test.ts` pass → the URL and secret stay out of logs, payloads, and audit   → AC-9
- [ ] Save a `CLEANUP` key pointing at a local receiver, run `npm run worker`, cancel a Current booking on a test testbed → one signed POST arrives with `X-HOL-Event`, `X-HOL-Delivery`, `X-HOL-Timestamp`, and a signature that verifies   → AC-5, AC-13
- [ ] Reply 500 from the receiver → the job retries; reply 404 → one `cleanup_hook.failed` audit row and the badge   → AC-6, AC-7
- [ ] Reschedule a Current booking → one `booking.moved` POST naming the old testbed and times   → AC-3

## Acceptance-criteria coverage

- AC-1 console checks met · AC-2 to AC-8 met in tests, live worker run owed · AC-9 met (scans and masked UI) · AC-10 met in tests · AC-11 owed (learner screens not watched) · AC-12 met in tests · AC-13 met in tests, live worker run owed
