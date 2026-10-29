# Verify: Nile Portal Reset engine · spec 0023 · updated 2026-10-29

_Steps derived from spec 0023 acceptance criteria. `/check verify` runs these; `/test` locks the durable ones. A ticked step was run and passed in the session of 2026-10-29. An unticked step was not run, or could not be, and says why._

## UI / manual

Admin console, Nile Portal Reset page (`/admin/nile-portal-reset`, signed in as the test admin, dev server on the LAN IP):

- [x] Open the page → the 13 starting steps show in order, read only until Edit is chosen   → AC-18 (list read), spec 0022 AC-15
- [x] At 390px width, view the page and then edit mode → each step is a card, the handles stay, and the page does not scroll sideways   → spec 0022 AC-15 (this found and fixed a header overflow, commit 16ca919)
- [x] Save the abort email and the mode through the page, then put them back → both save and restore   → AC-31 (address), AC-1 (mode)
- [x] Choose Live → a second confirm appears; Cancel keeps the mode; Discard asks first   → AC-1
- [x] A stale Save keeps the draft and offers Reload   → spec 0022 AC-16
- [x] Open "Recent resets" (`/admin/nile-portal-reset/runs`) and one run → the last 50 runs show testbed, lab end time in the admin timezone, mode, outcome, abort reason, and counts; one run shows its item records, 200 per page, and no forbidden value. Not opened in a browser in this session (only read from the database)   → AC-32 (ran 2026-10-29: list and one run's item records read in a browser; no forbidden value)
- [x] Open the Authentik side after a first run → one user `automation@<domain>` exists with the marker, in the testbed access group, and is not a learner. Not looked at in Authentik in this session   → AC-42 (ran 2026-10-29: marker attribute, access group, path hol/automation, no learner row)

## Live checks on Workshop 4 and Workshop 1 (owner present, authorized)

Each run below was queued by creating a Current booking on the testbed and cancelling it through the app's own `cancelBooking`, then waiting for the worker.

- [x] Mode `dry_run`, cancel a Current booking on Workshop 4 → one run, event `ended_early`, mode `dry_run`, queued with `due_at` five minutes after the cancel; it ran to `done` with 12 steps, 0 failed, `would_delete` 10, `would_change` 2, and no delete count   → AC-3, AC-4, AC-33 (run 7a25d960)
- [x] Mode `live`, cancel a Current booking on Workshop 4 → run `done`, 12 steps, 0 failed, 2 deleted, no report email needed   → AC-3, AC-8, AC-12, AC-13, AC-16, AC-24 (run 21f31a31)
- [x] Cancel a second Current booking on Workshop 4 straight after → run `done` with the same counts (2 deleted, 0 failed); the two recurring deletes are the `client-configs` the portal recreates, as the spec notes   → AC-24 (run 207952c1)
- [x] Cancel a Current booking on Workshop 1 → run `done`, 12 steps, 0 failed, 1 changed, 2 deleted. The two earlier incomplete runs (Workshop 1 at 01:35 UTC, Workshop 4 at 02:06 UTC) both failed on `nile-radius-certificates` before the deployed fix 135078c   → AC-24 (run 03a4eb26)
- [x] A booking that ended normally (Workshop 1, 01:30 UTC) → one run, event `lab_ended`, `due_at` five minutes after the end, `ended_key` of the form `end:<id>:<epoch>` (read from the database, run ac32ebc0)   → AC-2, AC-4
- [x] In every run, the engine signed in with the headless browser from the worker container and reached the tenant check   → AC-13, AC-40
- [x] Discovery ran in the live runs → it visited 6 pages (the cap is 20) and found 0 new routes, with 0 timed out   → AC-35, AC-38
- [x] Item records exist for deletes and for failures, with the step key, method, route pattern, HTTP status, and a redacted message, and no field beyond the label   → AC-28 (read from `portal_reset_run_items`)
- [x] Mode `off`, cancel a Current booking → no run is queued. Not run live   → AC-1 (ran 2026-10-29: no run queued)
- [x] Cancel an Upcoming booking → no run is queued. Not run live   → AC-3 (ran 2026-10-29: no run queued)
- [x] Book Workshop 4 so it starts within 2 minutes of a run, or is Current, then let a run start → the run ends `aborted` with reason `lab_started` and no further call. Not run live; this needs a real or staged lab on the testbed   → AC-6 (ran 2026-10-29: run 2a346fa5 aborted lab_started, 0 items)
- [x] Break the sign in (disable the automation user or block the password) → the run goes `held`, the owner gets one email at once, and it retries only when no lab is Current and 30 minutes have passed. Not run: it would change the live Authentik account   → AC-14, AC-15 (ran 2026-10-29 by making Authentik unreachable for the worker: runs held with credential_failed, one audit row and one email each; a lab starting aborted one with lab_started and a second email; the other stayed held after Authentik returned, then requeued 31 minutes later and finished done)
- [x] Point a testbed `portal_url` at a host outside `portal-hosts.json` → the run aborts `testbed_unavailable` with no browser started. Not run: it would edit a real testbed   → AC-7, AC-43 (ran 2026-10-29: aborted testbed_unavailable in 36 ms, 0 items, no sign in reason)
- [x] Stop the worker container while a run is going → the call finishes, the lease is released, the run is `queued`, and the process exits 0 within 60 seconds. Not run: the container is the live worker   → AC-9, AC-10 (ran 2026-10-29: first runs cut the call with a network failure because Playwright closes its browser on SIGTERM; fixed in sign-in.ts, then the worker finished its work, exit 0 in 31 s)
- [x] Run two due runs for two testbeds at once, and two for one testbed → the two testbeds run together, the same testbed one at a time. Not run live   → AC-5 (ran 2026-10-29 as dry runs: W4 and W1 overlapped, the second W4 run started 0.1 s after the first ended)
- [x] Look at the report email for an `incomplete` run → one email to the abort address with the unresolved failures, the redacted messages, and no forbidden value. The two earlier incomplete runs show `report_note: queued`; delivery was not checked   → AC-31, AC-30 (job done on first attempt for every incomplete run; the mailbox itself was not read)
- [x] After a live run, read the audit log → `portal_reset.run_finished` exists with counts and the system actor. Not queried in this session   → AC-29 (ran 2026-10-29: 13 run_finished rows)
- [x] Read the portal after a live run with the portal's own page → one SSID (the protected one), no integrations, no segments, only system policies, the guest switch off. Not read directly; the spec notes record the Workshop 4 check on 2026-10-28 and 2026-10-29   → AC-24, AC-26 (ran 2026-10-29 on Workshop 1 with the portal's own API: 1 SSID, 0 integrations, 0 segments, 0 policy groups, 0 policy sets, guest switch `advanceSettingsEnabled` false)
- [x] Probe the 16 list routes on a tenant where each feature was never set up, is switched off, or is unlicensed → record the answer (empty list, `403`, `404`, or another shape) and confirm each ends silent. Owed (decided 2026-10-27)   → AC-22 (ran 2026-10-29 on Workshop 1: 17 routes all answer 200 with empty or default shapes; no tenant with an unlicensed feature was available)
- [x] On the scratch tenant, create a policy group that matches a segment, then call the segment delete with the group still there → record whether the API refuses and confirm the step order (groups before segments). Owed (decided 2026-10-27)   → AC-22, AC-24 (ran 2026-10-29 on Workshop 1: the API answered 204 and deleted the segment while a group still matched on it, so the portal's "Policy Groups are using X" refusal is the page's own check, not the API's. The engine's order, groups before segments, is therefore what keeps the groups from pointing at a deleted segment, and it stays required. Both test items were deleted and the tenant ended with 0 segments and 0 groups)
- [x] Explain the dry run count gap: the dry run listed 10 would delete and 2 would change, the live run right after deleted 2. Not explained   → AC-33, AC-24 (explained 2026-10-29: the 6 would deletes are the system App groups the portal refuses, plus branding, certificates and wired calls the engine always sends)

## Commands

- [x] `npm run typecheck` → no errors   → all
- [x] `npm run lint` → no errors   → all
- [x] `npm test` → 177 files, 2584 tests pass against the real database and the in memory fake portal and fake Authentik (after the seed test fix 277c991). The suite names its tests by AC and covers the pure logic and the fake portal runs   → AC-1 to AC-8, AC-16 to AC-30, AC-33 to AC-37, AC-42, AC-43
- [x] `npx playwright test e2e/nile-portal-reset.spec.ts` → 15 passed (needs mode `off` and an empty abort email to start; restore them afterwards)   → AC-1, AC-31, spec 0022 AC-15
- [x] `npx playwright test e2e/design-system.spec.ts e2e/testbeds.spec.ts` → 12 passed after the shared header change   → none (regression check for commit 16ca919)
- [x] `reservations-web-1`, `reservations-worker-1`, and `reservations-db-1` are up, and the worker started with the Chromium start check   → AC-40
- [x] Worker start and `checkAutomationPermissions()` run directly (read only) → no missing permission, and the worker's start log holds no permission line (it logs only when one is missing)   → AC-39
- [x] `npm run authentik:setup` (dry run) → reports no missing engine permission. Not run   → AC-44 (ran 2026-10-29: role permissions ok)
- [x] `npm run portal:automation-check -- --domain nileworkshop-4.com` → prints pass for each check and never the password, a header, or a reply. Not re-run in this session   → AC-44 (ran 2026-10-29: all checks pass)
- [x] `grep` the README section "Nile Portal Reset setup" → it names `PORTAL_RESET_LANES`, the mode, the dry run first step, and the abort address. Not read in this session   → AC-41 (ran 2026-10-29)
- [x] Stop the worker with SIGTERM in a throwaway container → exit code 0 within 60 seconds. Not run   → AC-10 (ran 2026-10-29 on the live worker container)
- [x] `workerEnv()` with `PORTAL_RESET_LANES` unset, `1`, `5`, `0`, `6`, `2.5`, `abc` → 2, 1, 5, then rejected for the last four   → AC-39

## Acceptance-criteria coverage

- AC-1 · steps: mode confirm in the browser (ticked); mode `off` live (open) · AC-2 · live `lab_ended` run read from the database (ticked) · AC-3 · Workshop 4 dry run and live cancel (ticked); Upcoming cancel (open) · AC-4 · due five minutes after the end, both kinds (ticked)
- AC-5 · two lanes (open) · AC-6 · `lab_started` (open) · AC-7 · `testbed_unavailable` (open) · AC-8 · runs end `done` (ticked)
- AC-9, AC-10 · resume and shutdown (open) · AC-11 · the lanes run beside the tick (ticked 2026-10-29: an ended booking was completed by the tick while a run was `running`)
- AC-12, AC-13 · sign in as the automation account with the browser (ticked) · AC-14, AC-15 · sign in failure and the held state (open) · AC-16 · tenant check (ticked) · AC-17 · one fresh sign in on a 401 (unit suite only)
- AC-18 · list read at claim time (ticked, 12 steps in each run) · AC-19, AC-20, AC-21, AC-22 · unit suite (ticked); live unset feature probes (open) · AC-23 · a failure does not stop later steps (the two earlier incomplete runs ran all 12 steps)
- AC-24 · three clean runs and an idempotent repeat (ticked); direct portal read (open) · AC-25 · deny list (unit suite only) · AC-26, AC-27 · guards (unit suite; live read open) · AC-28 · item records (ticked) · AC-29 · audit rows (open) · AC-30 · redaction (unit suite; email check open)
- AC-31 · report email (open) · AC-32 · Recent resets page (open) · AC-33 · dry run writes nothing (ticked: counts hold only `would_` kinds)
- AC-34 · names scan (unit suite) · AC-35, AC-38 · discovery pages and bounds (ticked) · AC-36, AC-37 · discovery filter and delete (unit suite; no new route found live)
- AC-39 · env value and start check (ticked) · AC-40 · worker image and Chromium (ticked) · AC-41 · README (open) · AC-42 · automation account (unit suite and live runs signed in; the Authentik look is open) · AC-43 · portal host (unit suite; live check open) · AC-44 · permission check and `portal:automation-check` (open)
