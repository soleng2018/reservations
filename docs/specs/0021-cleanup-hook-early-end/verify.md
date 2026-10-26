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
- [x] Delete the test key when done → the key is gone (live database holds no live `CLEANUP` key)   → AC-1
- [x] After a real hook failure (404 from a live receiver), the key row shows a "Needs attention" badge, the host only, and the failed call line (owner's screenshot, 2026-10-26)   → AC-7, AC-9
- [ ] Sign in as a learner in a browser, cancel and reschedule a booking → the screens and results look the same as before this spec. Not done in a browser (no learner in Authentik). Checked instead: the branch changes no learner page or action, only `server/db/bookings.ts` with the same result types, and the 171 learner booking tests pass   → AC-11

## Commands

- [x] `npm run db:migrate` → "nothing to apply" (migration 0017 is live)   → AC-1, AC-7, AC-8
- [x] Query the live schema → index `api_keys_one_cleanup_uq`, column `api_keys.cleanup_failed_at`, `CLEANUP` in `api_keys_type_check`, and `cleanup_notify` in `jobs_kind_check` all exist   → AC-1, AC-7
- [x] `npx vitest run` → 126 files, 1980 tests, all pass against the real database (cancel and reschedule queueing, signed POST with a real local receiver, retries, stale cutoff, failure audit and guarded badge mark, jobs step never claims the hook)   → AC-2 to AC-8, AC-10, AC-12, AC-13
- [x] `npx tsc --noEmit` and `npm run lint` → no errors   → all
- [x] `tests/secret-column-scan.test.ts` and `tests/cleanup-hook-scan.test.ts` pass → the URL and secret stay out of logs, payloads, and audit   → AC-9
- [x] Save a `CLEANUP` key pointing at a local https receiver, run the real `npm run worker`, cancel two Current bookings on a test testbed → two `booking.ended_early` jobs queued with no URL or secret in the payload, then two signed POSTs arrive (`application/json`, `X-HOL-Event`, `X-HOL-Delivery`, `X-HOL-Timestamp`, signature verifies, no personal data in the body)   → AC-2, AC-5, AC-9, AC-13 (live, 2026-10-26)
- [x] Receiver replies 200 → the job is `done`; replies 404 → the job is `failed` after one attempt, one `cleanup_hook.failed` audit row (system actor, target the booking, `{event, reason: status_4xx}`), and the key's Needs attention flag is set   → AC-6, AC-7 (live)
- [x] On the rebuilt containers (`sha-2db4b38`), the owner saved a `CLEANUP` key at an unreachable host and cancelled a Current booking → one `booking.ended_early` job, a first attempt that failed with "The hook could not be reached." and went back to `pending`, and no URL or path in the worker log. Then the owner deleted the key → the retry finished `done` with no call, no `cleanup_hook.failed` row, and no mark (2026-10-26)   → AC-2, AC-6, AC-9, AC-10 (live)
- [ ] Receiver replies 500 → the job retries with backoff. Proven in the tests only, not against a live receiver   → AC-6
- [ ] Reschedule a Current booking → one `booking.moved` POST naming the old testbed and times. Proven in the tests only, not live   → AC-3

## Acceptance-criteria coverage

- AC-1 met (console) · AC-2, AC-5, AC-13 met live and in tests · AC-3 and the 500 retry of AC-6 met in tests only · AC-4, AC-8, AC-10, AC-12 met in tests · AC-6 (200 and 404) and AC-7 met live · AC-9 met (scans, masked UI, clean payloads) · AC-11 met by diff and tests, no browser look
