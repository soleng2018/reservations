# 0023. Nile Portal reset engine

**Date**: 2026-10-27
**Status**: Accepted
**Builds on**: [spec 0022](../0022-nile-portal-reset-page.md) (the step language, the saved list, the deny list, the guards, the mode), [spec 0020](../0020-cleanup-gap-between-labs/index.md) (the 30 minute gap), [spec 0021](../0021-cleanup-hook-early-end/index.md) (the early end event; the hook itself is unchanged), [spec 0013](../0013-email-delivery-booking-confirmations/index.md) (the job queue and mail), [spec 0016](../0016-admin-audit-log/index.md) (audit).
**Research**: [findings D1 to D17](../../research/nile-portal-reset-findings.md); prototypes in [portal-scripts](../../research/portal-scripts/README.md) (references only, not copied).

## Summary

After every lab, whether it ends at its booked time or early, the app resets that workshop's Nile Portal so the next learner starts on an empty tenant. A run starts 5 minutes after the lab ends and should finish within 25. The worker process does it: it creates (once) and then signs in as its own account for that workshop, `automation@<testbed domain>`, in Authentik, with a fresh random password it sets just before each sign in and never stores. It uses a headless browser only for the sign in, then makes plain API calls to run the saved step list from spec 0022 in order, retries failed calls, makes one more pass over what is left, and then runs a discovery pass that finds and removes kinds of things the list does not know yet and records that it did. No admin creates a user or a password. It never touches Identity or Users, never deletes the protected items, stops at once if a lab starts, and tells the abort address by email when it cannot finish. A mode switch (off, dry run, live) from spec 0022 starts at off.

## Requirements

**User stories**:
- As a learner, I want the lab I start to be on a clean tenant, so that nothing left by the previous learner changes what I see.
- As the owner, I want the reset to follow the list I keep on the Nile Portal Reset page, in that order, so that I can change it without a deploy.
- As the owner, I want a new kind of portal object that the list does not know to be found and removed anyway, and told about, so that the list can catch up.
- As the owner, I want to be emailed when a reset cannot sign in, aborts, or leaves something behind, with the portal's own message and never a secret, so that a failed reset is never silent.
- As the owner, I want Identity, Users, and the protected items to be impossible to delete by the reset, so that it can never lock me out of a tenant.
- As an admin, I want a dry run and a list of recent resets, so that I can trust the engine before it deletes anything.

**Acceptance criteria** (the contract, each independently checkable). They are grouped; numbering is continuous.

*Trigger and timing*
- **AC-1**: Runs are queued and claimed only while the settings `mode` is `dry_run` or `live`. With `off`, `queueEndedResets` inserts nothing, a Current booking cancel or move queues nothing, and a claimed run that finds `off` ends `aborted` with reason `mode_off`, no portal call, and no email.
- **AC-2**: A booking that has ended normally (`status in ('confirmed','completed')`, `ends_at <= now()`, `ends_at > now() - 45 minutes` and `ends_at >= settings.mode_changed_at`) on a testbed with a `domain` and a `portal_url` gets one run, event `lab_ended`, `ended_key` `end:<booking id>:<ends_at epoch seconds>`, by the worker step `queueEndedResets`. A repeat queues nothing (unique `ended_key`).
- **AC-3**: Cancelling a booking that is Current by the database clock queues one run in the same transaction, event `ended_early`, `ended_key` `early:<booking id>:<version>`, `lab_ended_at = now()`. Rescheduling a Current booking queues one run for the old testbed, event `moved`, `ended_key` `moved:<booking id>:<version>`. Cancelling or moving an Upcoming booking queues nothing. A cancel or move never fails or slows because of this queue (it is one insert in the same transaction, like spec 0021).
- **AC-4**: A run is claimable only when `now() >= due_at`, where `due_at = lab_ended_at + 5 minutes`, by the database clock. The target finish is `lab_ended_at + 25 minutes`. A run still going after the target keeps going, but is aborted with reason `deadline` at `lab_ended_at + 2 hours` (the hard cap).
- **AC-5**: At most one run per testbed is `running` (partial unique index `portal_reset_runs_one_running_uq`). A second due run for the same testbed waits. The number of runs going at once is `PORTAL_RESET_LANES` (default 2).
- **AC-6**: Before the first call and again before every write call (and every step), the engine runs one stop check in SQL by the database clock. It aborts the run, reason `lab_started`, with no further call, when a confirmed booking on the testbed is Current or starts within 2 minutes. It aborts with `mode_off` when the mode is now `off`, and with `deadline` past the hard cap. The same query renews the run's lease.
- **AC-7**: A run whose testbed was deleted, or has lost its `domain` or `portal_url`, or has a `portal_url` that fails AC-43, since it was queued ends `aborted` with reason `testbed_unavailable` before any call, and is emailed.

*Lifecycle and resume*
- **AC-8**: A run is `queued`, `running`, `held`, `done`, `incomplete`, or `aborted`. `done`: every enabled step finished and the final re-read found nothing left. `incomplete`: the engine finished its passes inside the time limits but something remains or failed. `aborted`: it stopped early (a reason from the list in Feature design). Each run records its pass, phase, per step progress, counts, and `finished_at` (database clock).
- **AC-9**: A running run holds a lease (`lease_until = now() + 90 seconds`, renewed by the stop check). A run whose lease has expired is claimed again by any lane and resumes in the same pass at the start of the step it was in (signing in again). Every step is safe to run again. After 3 resumes the run ends `aborted`, reason `crashed`.
- **AC-10**: On SIGTERM or SIGINT the lanes finish the call they are in, release their leases, leave the runs `queued` with their progress, and the process exits 0 within the 60 second stop window. No call is cut in the middle by an exit.
- **AC-11**: The lanes run beside the worker tick, not inside it, so a long run never delays the access reconciler or any other step. They run only in the process that holds the worker advisory lock.

*Sign in*
- **AC-12**: The engine signs in as `automation@<testbed domain>` to the origin of the testbed's `portal_url` (the Portal URL on the Testbed page, so a future region only needs a different value there). Just before each sign in it makes the credential right (AC-42): it makes sure the Authentik user exists and sets a new random password, which it holds in memory in a `Secret` and uses for that sign in only. There is no password file, no shared password, and no stored password. If the credential cannot be made right (AC-42), the run does not sign in, ends in the held state (AC-14), and no portal call is made.
- **AC-13**: The sign in uses a headless browser (Playwright, Chromium) for the portal and Authentik pages, then takes the three headers (`x-id-token`, `x-nile-client`, `x-requested-with`) from the first same origin `/api/` request that carries `x-id-token`. Every later call is plain HTTP with those headers. The browser stays open only to run the discovery pass (AC-31) and is closed when the run ends or fails.
- **AC-14**: A transient sign in failure (`browser_unavailable`, `portal_unreachable`, `timeout`, `token_missing`) is retried once after 20 seconds, then ends the run `aborted`. A failure that retrying cannot fix (`credential_failed`: Authentik was unreachable, refused the write, or the user could not be made; or `idp_rejected`: the sign in refused the password the app had just set, for example because the user is disabled or a policy or reputation block applies) puts the run in state `held` (not thrown away) and emails the owner at once (AC-15). The accounts are one per workshop, so a held run blocks no other testbed. A held run is tried again (back to `queued`, with a fresh credential) only when both hold: no confirmed booking on its testbed is Current or starts within 2 minutes (the same check as AC-6), and 30 minutes have passed since the last attempt. If a lab becomes Current on the testbed first, the held run ends `aborted`, reason `lab_started`, and one more email says that testbed was not reset. A held run has no 2 hour cap, but ends when the lab starts. Sign in reasons are a closed list: `credential_failed`, `idp_rejected`, `browser_unavailable`, `portal_unreachable`, `timeout`, `token_missing`.
- **AC-15**: A sign in failure that holds or ends a run does all of: no call to the portal other than the sign in itself; one audit row `portal_reset.sign_in_failed` (system actor, target the run, metadata `{ testbedId, domain, reason }`); one email to the abort address, queued in the same transaction that holds or ends the run, so it goes out as soon as the mail job runs. It is sent once per run, not again for later attempts of the same held run. The audit row, email, log line, and error never contain a password, a header, a cookie, a token, or the portal's raw reply.
- **AC-16**: After sign in, before any other call, the engine reads the signed in tenant (`GET /api/v1/userinfo`, then `GET /api/tenants/{tenantId}`) and compares the tenant name with the domain: both lower cased with every non letter and digit removed (`Nile Workshop-1`, `Nile Workshop 1`, and `nileworkshop-1.com` all give `nileworkshop1`). A mismatch ends the run `aborted`, reason `tenant_mismatch`, with no write, and is emailed.
- **AC-17**: A 401 on a later call causes one fresh sign in for the run and a retry of that call. A second 401 ends the run as a sign in failure (AC-15).

*Reading the list and running steps*
- **AC-18**: At claim time the engine reads the list once with `readResetList` (spec 0022 AC-16) and uses that snapshot for the whole run, including the second pass and resume. A step with `enabled: false` is skipped (and counted in the run summary). A step whose `definition` fails to parse ends the run `aborted`, reason `invalid_list`, and is emailed; nothing is skipped silently.
- **AC-19**: Order: sign in (step 0), tenant check, guard check (AC-27), then every enabled step in `position` order, then the discovery pass (AC-31 to AC-38), then a final re-read of every list the steps and the discovery used (a leftover is a failure), then, if anything failed or is left, one second pass over only those steps (and discovered routes), then a last final re-read. The second pass is the last: there is no third.
- **AC-20**: Each part of a step runs as defined in spec 0022: `read` keeps only its picked scalars; `delete_each` reads its list, drops items that fail `onlyWhen`, match `skipWhen`, or are guarded, and deletes the rest one by one (or in one call for `batch`); `call` sends one write; `update_record` re-reads just before each PUT and skips a record that already holds the value; `wait` pauses; `expect` fails the step when the value is not as expected. A `when` that does not hold skips the part with no record. The interpreter takes a portal interface and a stop check, so the same code runs against the real portal client and the in memory fake.
- **AC-21** (reply classification, one pure function): a status in `okStatus` is done. A `404` on a delete is done (already gone). A `404` on a list or read, or any status in `emptyOn`, is "nothing to do". A reply matching an `expectRefusals` entry is an expected refusal. A network error, a timeout (20 seconds per call), `429`, or `5xx` is retried up to 3 attempts in all (waits of 2 seconds, then 6 seconds), then is a failure. Any other `4xx` is a failure at once and not retried. A redirect is never followed and is a failure. A list that is not shaped as the step says (`itemsAt` not an array on a `200`) is a failure `bad_shape`. A reply body over 5 MB is a failure.
- **AC-22**: Empty, missing, and expected are silent (D9, D10). An empty list, a list of only skipped or guarded items, a feature that was never set up, an item already gone, an unmet `when`, a value already at its default, and an expected refusal each count as done: no retry, no item record, no audit row, no email, and not counted toward an abort. The engine never waits on, polls, or retries an empty step.
- **AC-23**: A failure in one item or one step never stops the later steps. Failures are recorded with the step key, item label or id, call (method and route pattern with `{id}`), HTTP status, and the portal's message (AC-30), and the step is marked for the second pass. Only the stop conditions of AC-6, AC-15, AC-16, AC-18, AC-25, and AC-27 end a run early.
- **AC-24**: Against the in memory fake portal, the 13 starting steps bring a populated tenant to the baseline: one SSID (the protected one), no integrations, no Wired entries and no Wired SSO config, only system policies, groups, and profiles, no segments, no admin RADIUS servers or Guest Portals, no Nile RADIUS policy except the Default Network Policy and that one set to REJECT, no certificates, no admin DHCP servers and no Nile DHCP scopes, the guest switch OFF, and the branding restore called. A second run against the result changes nothing (zero writes except the always restore call).

*Guards*
- **AC-25**: Every outgoing call of the engine, of any method and from any code path (steps, discovery, checks), passes through one function that refuses a path for which `isDenied` (spec 0022 AC-19) is true. A refusal sends nothing, throws a `GuardStop`, writes one audit row `portal_reset.guard_stop` (system actor, metadata the run, the step key, and the route pattern, never a value), ends the run `aborted` with reason `guard_stop`, and is emailed as a safety stop (loud, not a skip). The path checked is the final one, after placeholders are filled.
- **AC-26**: Hard guards (`guards.json`, spec 0022 AC-20). At the start of the run, after the tenant check, the engine reads each guard's list and computes the protected ids and counts. An `expectKept` mismatch (for example two SSIDs with `popTunnelUsed` true, or none while the list is not empty) ends the run `aborted`, reason `guard_stop`, with no write. Then, for the whole run, any `DELETE` or `PUT` whose path falls under a guard's `deleteRoutePrefix` and holds a protected id is refused before it is sent, whatever step, part, or discovered route made it. A guarded item is never deleted, never recorded as a failure, and never emailed (D9: system defined items are silent).
- **AC-27**: A guard check never depends on a name. A test feeds the fake portal a second captive portal SSID with `enableInternalGuest` true and `popTunnelUsed` false, and an SSID named like the protected one, and only the `popTunnelUsed` one survives.

*Reporting*
- **AC-28**: Per item records. Every item the engine deletes, every value it changes, and every failure writes a row in `portal_reset_run_items` (run, sequence, step key, kind `deleted`, `changed`, `failed`, `would_delete`, `would_change`, or `route_found`, the item label or id, the method and route pattern, the status, the redacted message, the pass, and for a failure whether the second pass resolved it). Expected and guarded items write nothing. A label is only ever the `labelField` value of a list; a list with no `labelField` records the id only; the engine copies no other field of a listed record.
- **AC-29**: Run level audit. The permanent audit log (spec 0016) gets, from the engine, only these rows, all with the system actor and target type `portal_reset_run`: `portal_reset.run_finished` (done or incomplete, with counts), `portal_reset.run_aborted` (reason), `portal_reset.sign_in_failed` (AC-15), `portal_reset.guard_stop` (AC-25), `portal_reset.route_found` (one per newly found route, AC-37), and `portal_reset.report_failed` (the report email job failed for good). `audit_events` stays append only (nothing here deletes from it). `portal_reset_runs` and their items are deleted 30 days after `finished_at` by the daily purge (a new `purgePortalResetRuns`). A run that is `queued` or `running` is never purged.
- **AC-30**: Redaction. The portal's message is taken only from the reply's `errors[].message` or `message` field, never the raw body; it is passed through `redactMessage` (the only way to make the branded text type that records and emails accept): URLs, email addresses, JWT shaped strings, and runs of 24 or more letters, digits, `-`, `_` are replaced with `[url]`, `[email]`, `[token]`; the result is cut to 300 characters. No audit row, item, email, log line, error, `jobs.payload`, or `last_error` ever holds the password, `x-id-token` or any header, a cookie, a webhook URL or token, a SIEM credential, a TSIG secret, a private key, a certificate, a recipient address, or a raw reply. A scan test fails if anything under `server/portal-engine/` calls `console.*`, or passes a reply body or header value to a log, audit, record, or email function.
- **AC-31**: Email. A run ends with one report email to the abort address, queued as a `send_reset_report` job (payload `{ runId }` only, idempotency key `reset-report:<run id>`) in the same transaction that finishes the run, when it ended `aborted` for any reason except `mode_off`, or `incomplete`, or recorded a `route_found`, in `live` mode. The email lists the testbed, workshop domain, and times; the reason; each unresolved failure with step, item, call, status, and message; the new routes found; the counts; and the passes made. It does not list items that failed once and were fixed in the second pass (they stay in the run records), nor any item deleted normally. A `done` run with nothing new sends no email. A dry run sends none. With no abort address saved, nothing is sent and the run record says so. Test address routing (`lib/email-routing.ts`) applies. The email carries no value listed in AC-30.
- **AC-32**: The admin console gets a read only "Recent resets" page (`/admin/nile-portal-reset/runs`, `requireAdmin()`): the last 50 runs with testbed, lab end time (admin timezone), mode, outcome, abort reason, and counts, and for one run its item records, 200 per page. It shows no value that AC-30 forbids.

*Dry run*
- **AC-33**: In `dry_run` every read and every guard check happens, and no write is sent: not a `DELETE`, a `PUT`, or the guest switch (a test counts writes on the fake and expects zero). `wait` is skipped. Items are recorded as `would_delete` and `would_change`. The run keeps the ids it would have deleted and hides them from later reads of the same run, so a later part does not list them twice. A dry run ends `done` and writes `portal_reset.run_finished` with `mode: "dry_run"`.

*Discovery pass* (D16). Discovery finds lists the saved steps do not cover and removes what is in them. It reads which pages to visit from data, which routes to skip from data, and has no portal object type names in code.
- **AC-34** (what is data and what is code): data is `pages` on steps (spec 0022 `definition.pages`), `lib/portal-reset/discovery.json` (`furniture` path patterns, `exclude` routes, `listShapes`, `labelFields`, `systemFlagFields`, `sharedThreshold`, `maxItemsPerRoute`), `guards.json`, and `deny-list.json`. Code holds only the algorithm below. A test (`tests/portal-engine-no-types.test.ts`) fails if a file under `server/portal-engine/` contains, outside comments, any of: `ssid`, `segment`, `radius`, `dhcp`, `siem`, `webhook`, `portalconfig`, `idps`, `users`, `popTunnelUsed`, `cloudDHCP`, `isDefault` (case insensitive).
- **AC-35** (collect): the engine visits each page in the union of enabled steps' `pages` (without duplicates, never a page on the deny list) in a fresh browser context per page, seeded from the in memory sign in state, waits for the network to be idle (30 seconds at most), and records every same origin `/api/` response that parses as a list of records (an array of objects with an `id`, found at one of `listShapes`), keeping the first good parse of a path, plus the page's visible text. A page that times out is counted in the run summary and skipped. The browser state is never written to disk.
- **AC-36** (filter): a path is normalised (ids, uuids, and tenant prefixed ids become `{id}`; the query is dropped). A candidate is dropped when it matches `furniture`, is on the deny list (silent: the portal reads Identity on its own pages), appears on `sharedThreshold` or more pages, is in `exclude`, or is already covered by a step (equal to a step's list path, or under a step's delete route). A candidate that is a segment prefix of, or is prefixed by, another candidate or a step route is a related route: it is not deleted, and is reported once as `route_found` with outcome `related`.
- **AC-37** (confirm, delete, record): a remaining candidate is accepted only if it was listed by a `GET`, has at most `maxItemsPerRoute` (25) records, and at least one record's label (the first present of `labelFields`, at least 2 characters) appears in the page text. A record with any `systemFlagFields` property true is presumed a system item: skipped silently and counted. In `live` mode the engine deletes each remaining record by convention, `DELETE <list path without query>/{id}`, using the AC-21 classification (a `404` or `405` on the derived route means the convention does not hold: reported, not retried, not in the second pass). It then re-reads the list; anything left is a failure. For each route it writes one `route_found` item and one `portal_reset.route_found` audit row holding the page, the method and route pattern, the count found, deleted, skipped, and left, the status tally, and the type label (a route pattern, never a record body), and it adds a "new route found" block to the email. A candidate that was a POST list, over the cap, or uncorrelated is reported as `route_found` with deleted 0 and the reason, and nothing is deleted.
- **AC-38** (bounds): discovery does not start after `lab_ended_at + 15 minutes` (counted in the run summary as skipped for time), visits at most 20 pages, and stops after 5 minutes. All guards of AC-25 and AC-26 apply to every discovered call. A discovered route on the deny list is never called.

*Operations*
- **AC-39**: New environment values are read only through `server/env.ts`: `PORTAL_RESET_LANES` (integer 1 to 5, default 2). There is no password file and no new secret: the engine uses the existing Authentik provisioning token. The worker's start check also confirms the provisioning role holds the permission AC-42 needs (a read of its permissions) and logs once, without stopping the worker, if it does not.
- **AC-40**: Chromium is installed only in the worker image target, and `playwright-core` is a runtime dependency (the dev only `@playwright/test` stays as it is). The web image does not grow. `npm run build:bundle` bundles the engine into the worker, and the worker's start check launches and closes the browser once (like the email renderer check) and exits 1 if it cannot, so a bad image is found at deploy.
- **AC-42** (the automation account, owned by the app): for each workshop the app owns one Authentik user, `automation@<testbed domain>`, and its password. `ensureAutomationCredential(testbed)` in `server/authentik/portal-automation.ts` runs before every sign in, using the provisioning token. It finds the user by exact username. If none exists it creates it exactly as the `nile-idp` script creates `admin@`: type `internal`, active, path `hol/automation` (not `hol/learners`, which the Nile authorization flow can deny), name `Nile Portal Automation`, `attributes.mail` equal to the username (the SAML NameID and the portal's domain routing use it), `firstName` `Automation`, `lastName` `Portal`, `mobile` empty, plus the marker `hol_portal_automation: true`. It then makes sure the user is a member of the testbed's access group, the one named by `testbeds.group_name` (spec 0017), which must carry `hol_testbed_group` and have `hol_testbed_domain` equal to the testbed's domain, read fresh each time; that membership is what the portal maps to Administrator (`memberOf` contains the group, spec 0023 rationale). The user is not given `hol_learner`, so the access reconciler never counts or removes it. Finally it generates a random password of 40 characters from the system random source (letters, digits, and symbols, passing Authentik's policy), sets it, and returns it only as a `Secret`. The password is never written to a file, a database row, a job, a log, an audit row, or an email, and it is replaced at the next run. Nobody, admin or owner, ever sees or sets it. A new gate in `guard.ts`, `guardAutomationWrite`, allows exactly three writes: create the user, set its password, and add it to that one group. It applies only when the username is `automation@<domain>` for a live testbed and the user either does not exist or carries `hol_portal_automation: true`. It refuses (no write) a user that exists without the marker, a superuser, anyone in `hol-admins`, and a group that lacks the marker or the matching domain, and it can change nothing else. The first creation writes one audit row `portal_reset.automation_user_created`; a failure writes `portal_reset.credential_failed` with `{ domain, result }` where `result` is one of `refused`, `group_missing`, `not_found`, `failed`, never the password. Tests with the fake Authentik assert on `writes`: at most one create, one group add, and one `set_password`, and none for an `admin@` user, a superuser, an unmarked user, a learner, another domain, or a group without the marker.
- **AC-43** (portal host): a testbed's `portal_url` is used only if it parses as `https`, has no username or password, and its host equals or ends with a suffix in `lib/portal-reset/portal-hosts.json` (starting value `["nile-global.cloud"]`). The sign in uses its origin only. Anything else ends the run `aborted`, reason `testbed_unavailable`, with no browser started, and is emailed. This keeps the credential from being typed into a page that a typo or a bad edit pointed elsewhere.
- **AC-44** (permission setup and the live test): The provisioning role already holds every permission the engine needs (`authentik_core.add_user`, `add_user_to_group`, `change_user`, and `reset_user_password`, read from Authentik on 2026-10-27; it still has no delete), so no grant is made. `npm run authentik:setup` gets a dry run only check that reports if one of those permissions is missing, and a worker start check reports a missing permission once. A one off check script, `npm run portal:automation-check -- --domain <domain>` (dry run by default, `--apply` does the work), uses the same modules as the engine: it runs `ensureAutomationCredential`, signs in to the portal as the new user through `sign-in.ts`, reads the tenant (AC-16), and makes one harmless `GET` on a list that only an administrator can read. It prints only pass or fail per check and the user's group names, never the password, a header, or a reply, and it creates no other object. It is run by the build, on Workshop 4 (`nileworkshop-4.com`), not by the owner.
- **AC-41**: The README section "Nile Portal Reset setup" is updated to the shipped names (`PORTAL_RESET_LANES`, the mode, the dry run first step, and the abort address).

## Decision

**Chosen option**: Option 1: Lanes in the worker process, resumable runs stored in the database, a headless browser only for sign in and discovery.

The worker starts a small number of run lanes beside its tick. Each lane claims a due run, signs in, interprets the saved step list with one portal interface, runs the discovery pass, and finishes the run in one transaction that writes the outcome, the run level audit rows, and the report email job.

**Implementation skills**: `kysely` (`mindrally/skills`, `.claude/skills/kysely/`) · `zod` (`pproenca/dot-skills`, `.claude/skills/zod/`) · `vitest` (`antfu/skills`, `.claude/skills/vitest/`) · `playwright-cli` (`microsoft/playwright-cli`, `.claude/skills/playwright-cli/`) · `playwright-best-practices` (`currents-dev/playwright-best-practices-skill`, `.claude/skills/playwright-best-practices/`) · `react-email` (`resend/react-email`, `.claude/skills/react-email/`) · `supabase-postgres-best-practices` (`supabase/agent-skills`, `.claude/skills/supabase-postgres-best-practices/`)

**New dependency**: `playwright-core` as a runtime dependency (its version matches the installed `@playwright/test`), and Chromium in the worker image only.

## Rationale

The reasoning, the options for where it runs, how it signs in, and where per item records live are in [rationale.md](rationale.md).

## Feature design

**Where the code lives**: `server/portal-engine/` (every module imports `server-only`; nothing under `app/admin/nile-portal-reset/`, `server/portal-reset/`, or `lib/portal-reset/` may import it, spec 0022 AC-14). Pure rules in `lib/portal-reset/` so the page and the engine share them.

| File | Owns |
|---|---|
| `lib/portal-reset/timing.ts` | the constants (below) |
| `lib/portal-reset/rules.ts`, `template.ts` | `evaluateRules`, `evaluateConds`, `fillTemplate`, `pickItems`, `resolvePath` (pure) |
| `lib/portal-reset/classify.ts` | the AC-21 reply classification and retry policy (pure) |
| `lib/portal-reset/redact.ts` | `redactMessage` and the branded `RedactedText` type (pure) |
| `lib/portal-reset/discovery-rules.ts`, `discovery.json` | the AC-34 to AC-38 filters, path normalisation, related route test (pure) and their data |
| `server/portal-engine/secret.ts` | the `Secret<T>` wrapper: `toString`, `toJSON`, and Node's inspect all return `[redacted]` |
| `server/portal-engine/sign-in.ts` | `signIn(deps, { portalUrl, username, password })` returning `Result<Session, SignInReason>`; the selectors from the prototype `00-login-and-read.mjs` (`#idp-discovery-username`, `#idp-discovery-submit`, `input[name="uidField"]`, the password step, Continue); the Playwright browser is created here |
| `server/portal-engine/client.ts` | `makePortalClient(session, fetchImpl)`: `call(req)`; the single choke point (deny list, guards, redirect `manual`, 20 second timeout, 5 MB cap, headers); returns a typed `Result` |
| `server/portal-engine/guards.ts` | `loadGuards`, `computeProtected(portal, guards)`, `checkWrite(path, protected)` |
| `server/portal-engine/interpret.ts` | `runStep(def, ctx)` and the part runners (AC-20) |
| `server/portal-engine/run.ts` | `executeRun(run, deps)`: passes, phases, progress, stop check, finish |
| `server/portal-engine/discovery.ts` | the browser part of AC-35 and the delete and verify loop (AC-37) |
| `server/portal-engine/queue.ts` | `queueEndedResets` (worker step) and `queuePortalReset(trx, ...)` (called from the cancel and move code) |
| `server/portal-engine/claim.ts` | `claimDueRun` (`FOR UPDATE SKIP LOCKED`), `stopCheck`, lease renewal |
| `server/portal-engine/report.ts` | `finishRun` (one transaction: state, run audit rows, report job) and the email builder inputs |
| `server/portal-engine/lanes.ts` | `runLanes(deps, { lanes, shouldStop })`: N loops of claim, execute, pause 15 seconds when idle |
| `server/portal-engine/purge.ts` | `purgePortalResetRuns` (called by the worker's daily purge) |
| `server/portal-engine/testing.ts` | the in memory fake portal: a table per list route, the same reply shapes as the research, a write counter, and switches for `404`, `5xx`, a refusal, and a slow reply |
| `server/jobs/send-reset-report.ts`, `server/email/templates/reset-report.tsx` | the `send_reset_report` handler and template |
| `app/admin/nile-portal-reset/runs/` | the Recent resets pages |

**Constants** (`lib/portal-reset/timing.ts`, plain values, tested): `START_DELAY` 5 minutes, `TARGET` 25 minutes, `HARD_CAP` 2 hours, `START_MARGIN` 2 minutes, `LOOKBACK` 45 minutes, `LEASE` 90 seconds, `MAX_RESUMES` 3, `ATTEMPTS` 3, `BACKOFF` 2 s and 6 s, `CALL_TIMEOUT` 20 s, `SIGN_IN_RETRY_DELAY` 20 s, `HELD_RETRY` 30 minutes, `DISCOVERY_START_LIMIT` 15 minutes, `DISCOVERY_BUDGET` 5 minutes, `DISCOVERY_MAX_PAGES` 20, `RETENTION` 30 days, `IDLE_PAUSE` 15 seconds.

**Data model sketch** (migration `0019_portal_reset_runs.sql`, after spec 0022's `0018`):

`hol_app.portal_reset_runs`

| Column | Type | Rules |
|---|---|---|
| id | uuid, primary key, default `gen_random_uuid()` | |
| testbed_id | uuid, not null, foreign key to `testbeds(id)` | |
| booking_id | uuid, null, foreign key to `bookings(id)` | the lab that ended |
| ended_key | text, not null | unique (`portal_reset_runs_ended_key_uq`); the idempotency key (AC-2, AC-3) |
| event | text, not null | `check (event in ('lab_ended','ended_early','moved'))` |
| mode | text, not null | `check (mode in ('dry_run','live'))`; the mode when the run started |
| lab_ended_at | timestamptz, not null | the database clock |
| due_at | timestamptz, not null | `lab_ended_at + 5 minutes`, set by the insert |
| state | text, not null, default `'queued'` | `check (state in ('queued','running','held','done','incomplete','aborted'))` |
| abort_reason | text, null | `check (abort_reason in ('mode_off','sign_in_failed','tenant_mismatch','guard_stop','lab_started','deadline','testbed_unavailable','invalid_list','crashed'))`; set when and only when state is `aborted` (check) |
| sign_in_reason | text, null | the six AC-14 reasons, set with `sign_in_failed` |
| progress | jsonb, not null, default `'{}'` | `{ pass, phase, doneSteps, failedSteps }`; keys only, no values from the portal |
| resumes | smallint, not null, default 0 | `check (resumes between 0 and 3)` |
| lease_until | timestamptz, null | |
| counts | jsonb, not null, default `'{}'` | numbers only: deleted, changed, failed, resolved, skippedSteps, discoveryPages, and so on |
| report_note | text, null | `not_needed`, `no_address`, `queued` |
| started_at, finished_at | timestamptz, null | database clock |
| created_at | timestamptz, not null, default `now()` | |

Indexes: `(state, due_at)` for the claim; unique partial `portal_reset_runs_one_running_uq on (testbed_id) where state = 'running'`; `(finished_at)` for the purge.

`hol_app.portal_reset_run_items` (on delete cascade from the run)

| Column | Type | Rules |
|---|---|---|
| id | uuid, primary key | |
| run_id | uuid, not null, foreign key | |
| seq | integer, not null | unique with `run_id` |
| step_key | text, not null | `check (char_length(step_key) <= 80)`; `discovery` for discovered routes |
| kind | text, not null | `check (kind in ('deleted','changed','failed','would_delete','would_change','route_found'))` |
| label | text, null | `check (char_length(label) <= 120)`; the `labelField` value only |
| item_id | text, null | `check (char_length(item_id) <= 200)` |
| method | text, null | `check (method in ('GET','POST','PUT','DELETE'))` |
| route | text, null | the route pattern with `{id}`, at most 200 characters; never a resolved URL |
| status | integer, null | the HTTP status |
| message | text, null | `check (char_length(message) <= 300)`; redacted (AC-30) |
| pass | smallint, not null | `check (pass in (1,2))` |
| resolved | boolean, not null, default false | for `failed`: true when the second pass fixed it |
| detail | jsonb, null | for `route_found`: `{ page, found, deleted, skipped, left, statusTally, outcome }`, numbers and fixed words only |
| created_at | timestamptz, not null, default `now()` | |

The same migration adds `send_reset_report` to `jobs_kind_check` (and `JobKind` in `lib/db-enums.ts`, the `HANDLERS` entry in `worker/index.ts`), extends `audit_events_target_type_check` with `portal_reset_run`, and adds Zod enums and `checkLists` entries for `portal_reset_runs.event`, `.mode`, `.state`, `.abort_reason`, `portal_reset_run_items.kind`, `.method`. New constraint names are added to `mapConstraintError` where a user facing message could result (none expected).

**State transitions**: `queued` to `running` (claimed, `now() >= due_at`, no other running run for the testbed); `running` to `done`, `incomplete`, or `aborted` (finish, one transaction); `running` to `held` (the password was rejected, AC-14); `held` to `queued` (a retry is due, AC-14); `running` to `queued` (lease expired and resumed, or released on shutdown); `queued` to `aborted` (`mode_off`, `deadline`, `testbed_unavailable`, `sign_in_failed` cooldown). Terminal states never change.

**Run algorithm** (`executeRun`):
1. Claim (`FOR UPDATE SKIP LOCKED`; `state in ('queued')` or a `running` run with an expired lease): set `running`, lease, `started_at`. Read the mode and the list in one `readResetList` snapshot. `off` ends the run `mode_off`. A step that does not parse ends `invalid_list`.
2. Stop check, then sign in (AC-12 to AC-15), then the tenant check (AC-16), then guard setup (AC-26).
3. For each enabled step in order: stop check, `runStep`, record events, store progress. A step result is `done` or `failed`.
4. Discovery pass (AC-34 to AC-38).
5. Final re-read: every `delete_each` list read again with its rules (leftovers, honouring `allowLeftover`), every `update_record` match tested again, every `expect` re-read, every discovered list read again. Anything left marks its step failed.
6. If any step failed: pass 2 over only those steps (and discovered routes whose derived route worked), then the final re-read again.
7. Finish in one transaction: state (`done` when nothing failed or is left, else `incomplete`), counts, run audit rows, the report job. Close the browser in a `finally`.

**The portal interface** (what the interpreter sees): `call({ method, path, body? }): Promise<Result<{ status, body: unknown }, CallError>>`. The body goes straight into the pure helpers and is dropped; only `id`, `labelField`, picked scalars, and a redacted message ever leave them.

**Audit actions** (added to `AuditAction`, none has a DB CHECK): `portal_reset.run_finished`, `portal_reset.run_aborted`, `portal_reset.sign_in_failed`, `portal_reset.guard_stop`, `portal_reset.route_found`, `portal_reset.report_failed`, `portal_reset.credential_failed`, `portal_reset.automation_user_created`, all system actor, target type `portal_reset_run`. `lib/audit-log.ts` gets labels and the existing `portal_reset` area; the actor kind table maps all eight to `system`; `resolveTargets` labels a run as "Reset of <testbed name> at <time>".

**Value sourcing**:

| Action | Value produced / displayed | Source |
|---|---|---|
| Queue a normal end | `testbed_id`, `booking_id`, `lab_ended_at`, `ended_key` | the `bookings` row (`ends_at`, `testbed_id`, `id`) |
| Queue an early end | `lab_ended_at` | SQL `now()` in the cancel or move transaction |
| Queue | `due_at` | `lab_ended_at + 5 minutes` (`START_DELAY`) |
| Queue | whether to queue at all | `portal_reset_settings.mode`, `mode_changed_at`, and `testbeds.domain` and `.portal_url` not null |
| Sign in | the portal address | `new URL(testbeds.portal_url).origin`, checked by AC-43 (today every workshop has the same host; the username picks the tenant) |
| Sign in | the username | `automation@` plus `testbeds.domain` |
| Sign in | the password | generated per sign in by `ensureAutomationCredential` (random, 40 characters), set in Authentik, held in a `Secret`, never stored |
| Sign in | the group the user must be in | the testbed's `group_name`, checked to carry `hol_testbed_group` and a `hol_testbed_domain` equal to the testbed's domain |
| Sign in | the three headers | the first same origin `/api/` request that carries `x-id-token`, held in a `Secret` |
| Tenant check | the expected and actual tenant names | the domain's first label, and `GET /api/tenants/{tenantId}` with `tenantId` from `GET /api/v1/userinfo` |
| Steps | the list, order, enabled flags, mode, abort address | `readResetList` snapshot at claim |
| Steps | ids, labels, parent ids | the list reads, through `idField`, `labelField`, `nested.parentIdField` |
| Steps | values for branches | `read.pick` scalars kept in memory for the step |
| Steps | protected ids and counts | `guards.json` lists read at run start |
| Stop check | Current or soon starting booking, hard cap, mode | SQL over `bookings`, `portal_reset_runs`, `portal_reset_settings` with `now()` |
| Item records | message | `redactMessage` of `errors[].message` or `message` |
| Item records | route | the route pattern from the step (placeholders unfilled) |
| Discovery | pages | `definition.pages` of enabled steps |
| Discovery | candidates, their labels, the page text | the browser's responses and `innerText` |
| Finish | counts, outcome | derived from the item records and step results |
| Report | recipient | `abortEmail` from the snapshot |
| Report | message body | built by the handler from the run and its items at send time, never from `jobs.payload` |
| Recent resets | times | `lab_ended_at`, `finished_at` in the admin timezone through `lib/format-time.ts` |
| Purge | the cutoff | SQL `now() - 30 days` |

**Key invariants**:
- A guarded item and a denied path are never sent a write, whatever the list, a resume, or discovery says.
- No portal call is made after a stop condition fires.
- At most one running run per testbed.
- A run never writes while a lab is Current or starting within 2 minutes on its testbed.
- Every run ends in one of `done`, `incomplete`, `aborted`, in one transaction that also queues its report.
- The password, headers, cookies, tokens, certificates, URLs of integrations, and recipient addresses exist only in memory, in `Secret` wrappers or local variables, and nowhere else. The password is also replaced at every run.
- `audit_events` is never updated or deleted by this feature.

**Security model**:
- The engine runs only in the worker process, only with the worker advisory lock. Nothing in the web process calls a portal or creates the automation user.
- The accounts are one per workshop with a new random password at every run, so there is no shared password to leak or to lock, and a problem with one workshop cannot touch the others. The held state with no repeat attempts inside a run (AC-14) is the defence against a repeated rejection. The account is an administrator of its own tenant only, because its only group is that tenant's access group.
- **A new, narrow Authentik write (approved by the owner, 2026-10-27):** the app creates and sets the password of one non learner user per workshop, `automation@<domain>`, and adds it to that testbed's access group. Creating new objects is allowed by the owner's write boundary; the password and group writes are gated by `guardAutomationWrite` (exact username, a marked or absent user, a marked testbed group with the matching domain, never an admin or superuser), so it cannot change an existing user the app did not make. It changes the rule in `server/authentik/AGENTS.md` that the guard allows user writes only for learners. The portal host allow list (AC-43) keeps the credential from being typed anywhere else. The provisioning role already holds the permissions this needs (AC-44).
- The destructive surface is bounded by five layers: the mode (default off), the deny list, the guards, the closed step language, and the stop check against running labs.
- The browser context holds a live session. It is never written to disk, and is closed in a `finally`. The Chromium sandbox stays on; the container does not run it as root.
- Free text from the portal is shown only after `redactMessage` and rendered as text.
- Compliance scope: the portal replies can contain personal data (recipient addresses, user names). Only labels the list names are recorded, and nothing is sent to a third party.

**Configuration required**:
- No password setting. The engine uses the existing Authentik provisioning token and generates each password itself.
- `PORTAL_RESET_LANES`: integer 1 to 5, default 2.
- Prerequisites before the first live run: every testbed that gets a reset has a `domain` and a `portal_url` on an allowed portal host; the abort address is saved on the Nile Portal Reset page; run a dry run first.

**Critical test scenarios** (each maps to an acceptance criterion):
- Happy path: with the fake portal populated, a due `live` run signs in (the fake sign in), runs the 13 steps, discovers nothing, ends `done`, and the fake is at the baseline, verifies **AC-19, AC-20, AC-24**
- Idempotent: a second run on the result changes nothing except the always restore call, verifies **AC-24**
- Timing: a run is not claimed at `due_at - 1 second` and is at `due_at`; an ended booking queues once; a Current cancel and a Current move queue in the same transaction and an Upcoming one does not, verifies **AC-2, AC-3, AC-4**
- Concurrency: two lanes and two due runs for one testbed run one at a time; for two testbeds they run together, verifies **AC-5**
- Stop: a booking that starts during the run (the stop check sees Current, or a start within 2 minutes) aborts with `lab_started` and no further call; mode flipped to `off` aborts with `mode_off` and no email; the hard cap aborts with `deadline`, verifies **AC-6, AC-1, AC-4**
- Resume and shutdown: a lease that expires mid step is resumed and ends the same as an uninterrupted run; the fourth resume ends `crashed`; a stop signal finishes the call and leaves the run `queued`, verifies **AC-9, AC-10**
- Sign in: `credential_failed`, `idp_rejected`, and a transient failure give the right reasons; the transient one retries once; the other two hold the run, email at once, retry only when no lab is active and 30 minutes passed, and end `lab_started` (with a second email) if a lab begins first; one audit row each; no secret anywhere, verifies **AC-12, AC-14, AC-15**
- Automation account: the first run creates the user with the marker and writes `automation_user_created`; later runs create nothing and set a new password each time; the password differs between runs and between testbeds; it is in no row, log, job, audit row, or email; the fake Authentik records only create and `set_password` for `automation@` plus a live domain, and nothing for an `admin@` user, a superuser, an unmarked user, a learner, or another domain, verifies **AC-42**
- Live automation account (run by the build, not the owner, on Workshop 4): `portal:automation-check --apply` creates `automation@nileworkshop-4.com` with the same shape as `admin@` (internal, mail attribute, member of `NileWorkshop4Admin`), sets a password, signs in to the portal through the real sign in, lands in the right tenant, and reads an administrator only list; a second run creates nothing and succeeds with a new password; a run with the user removed from the group fails with `group_missing` or a sign in refusal, not a pass; the access reconciler leaves the user in the group, verifies **AC-42, AC-44**
- Portal host: a `portal_url` that is `http`, has credentials, or a host outside the allow list aborts with no browser started, verifies **AC-43**
- Tenant: the three tenant name forms compare equal; a wrong tenant aborts before any write, verifies **AC-16**
- 401: one fresh sign in and a retry; a second 401 is a sign in failure, verifies **AC-17**
- Classification: a table test of status and body to outcome (ok, 404 delete, 404 list, expected refusal, 400 other, 429, 500 with retries, timeout, redirect, bad shape, oversize), verifies **AC-21**
- Silent cases: an empty tenant, a tenant with only system items, a missing feature (`404`), an item gone before delete, a value already at default all end `done` with no item record, no audit row, no email, verifies **AC-22**
- Failure case: a `5xx` that persists on one item fails it, the other items and steps still run, the second pass retries only that step, and an unresolved one is emailed with the redacted message, verifies **AC-23, AC-28, AC-31**
- Deny list: a test step (written straight into the snapshot) that calls `/api/v1/idps` or `/api/v1/users/x` sends nothing, writes `guard_stop`, aborts, and emails, verifies **AC-25**
- Guards: two SSIDs with `popTunnelUsed` true, or an empty set while others exist, abort before a write; a step that lists SSIDs by another path and deletes under the SSID route still cannot delete the protected id; the look alike SSIDs of AC-27 survive; system policies, Nile RADIUS, Nile DHCP, and the Default Network Policy survive every step and discovery, verifies **AC-26, AC-27**
- Redaction: a portal message holding a URL, an email address, and a token comes out as `[url]`, `[email]`, `[token]` and is cut to 300; the scan finds no `console` or secret use; the email subscription label is not recorded, verifies **AC-28, AC-30**
- Dry run: zero writes on the fake; `would_*` records; no email; the virtual deletes hide items from later reads, verifies **AC-33**
- Discovery: the fake serves a new list on a page; it is found, correlated by name, deleted by convention, re-read, recorded, audited, and emailed; a furniture list, a shared list, a denied list, a child or related list, a POST list, a list over 25, an uncorrelated list, and a record with a system flag are each left alone and reported or skipped as specified; a `405` on the derived route is reported and not retried; the discovery time limits hold, verifies **AC-34 to AC-38**
- Names scan: no type name from AC-34 under `server/portal-engine/`, verifies **AC-34**
- Retention: items and runs older than 30 days are purged with their items; `audit_events` rows stay; a running run is never purged, verifies **AC-29**
- Report job: the job payload holds only the run id; a missing abort address sends nothing and says so; a final job failure writes `report_failed`, verifies **AC-31, AC-29**
- Recent resets: admin only; shows no forbidden value, verifies **AC-32**
- Worker: the lanes start only with the lock and beside the tick; the start check launches the browser once and exits 1 if it cannot, verifies **AC-11, AC-40**
- Unset features (decided 2026-10-27, to be answered while building): for each list route in the 13 steps, a probe test records what the fake and, by hand, a scratch tenant answer when the feature was never set up, is switched off, or is unlicensed (empty list, `403`, `404`, or another shape). The fake has a switch for each of those answers. The test fixes the table of answers per step and the step's `emptyOn`; an answer nobody has classified is a failure `bad_shape` or `4xx`, never silently empty, verifies **AC-21, AC-22**
- Segment still used by a group (decided 2026-10-27, tested while building): by hand on the scratch tenant, create a policy group that matches a segment and call the segment delete with the group still there; record whether the API refuses. The fake gets a switch for both answers and the order test (groups before segments) runs under each, verifies **AC-19, AC-23**
- Live check by hand (not CI): one dry run and then one live run against Workshop 4 (the scratch tenant) with the owner present, verifies **AC-12, AC-13, AC-16, AC-24**

## Build plan

Build approach: Tracer Bullet (the project default). The first thread is thin and real: a queued run for one testbed, the stop check, the interpreter running one trivial step against the in memory fake, one run level audit row. Then thicken: the classification and retries, the guards, the real sign in and portal client, the real steps, reporting, discovery, operations. Spec 0022 tasks 1 to 6 (language, seed, migration, read module) come first.

1. [x] Pure rules: `rules.ts`, `template.ts`, `classify.ts`, `redact.ts`, `timing.ts`, the `Secret` wrapper, with plain tests, satisfies **AC-21, AC-22, AC-30**
2. [x] Migration `0019_portal_reset_runs.sql` (both tables, indexes, job kind, audit target type), Zod enums and `checkLists`, `db:codegen`, new `AuditAction` values and Audit Log labels, satisfies **AC-8, AC-29**
3. [x] Tracer thread: `queue.ts` (`queueEndedResets`, `queuePortalReset` called from the cancel and move code), `claim.ts` (claim, lease, stop check), `lanes.ts` wired into `worker/index.ts` beside the tick, `run.ts` skeleton with the fake portal, the fake sign in, one step, and `finishRun`, satisfies **AC-1, AC-2, AC-3, AC-4, AC-5, AC-6, AC-8, AC-11**
4. [x] The in memory fake portal (`testing.ts`) with the reply shapes from the research, and the interpreter (`interpret.ts`) for all part kinds, with the 13 starting steps and the AC-24 baseline test, satisfies **AC-19, AC-20, AC-22, AC-23, AC-24**
5. [x] Guards and the single call choke point: `guards.ts`, `client.ts` (deny list, redirect manual, timeout, size cap, retries), satisfies **AC-25, AC-26, AC-27**
6. [x] Resume, shutdown, passes, and the final re-read: lease and resume, the second pass, `allowLeftover`, the stop on SIGTERM, satisfies **AC-9, AC-10, AC-19, AC-23**
7. [x] Reporting: item records, run level audit rows, the `send_reset_report` handler and template, the purge, satisfies **AC-28, AC-29, AC-31**
8. [x] Dry run: the virtual deletes and `would_*` records, satisfies **AC-33**
9. Real sign in: the `authentik:setup` permission check and `portal:automation-check` (AC-44), then the automation account (`server/authentik/portal-automation.ts`, `guardAutomationWrite`, `automation-user.json`, the fake Authentik tests), the portal host allow list, `sign-in.ts` with Playwright against the prototype's selectors, the header capture, the tenant check, the failure reasons, retry, and the held state, satisfies **AC-12, AC-13, AC-14, AC-15, AC-16, AC-17, AC-39, AC-42, AC-43, AC-44**
10. [x] Discovery: `discovery-rules.ts` and `discovery.json`, then the browser collector and the delete and verify loop, satisfies **AC-34, AC-35, AC-36, AC-37, AC-38**
11. [x] Recent resets pages, satisfies **AC-32**
12. [x] Image and operations: Chromium in the worker target, `playwright-core` runtime dependency, compose secret, the worker start check, README update, satisfies **AC-40, AC-41**
13. Tests: the secret and names scans, the DB integration tests inside `inRollback`, then the by hand dry run and live run on the scratch tenant, satisfies **AC-24, AC-30, AC-34**

## Consequences

**Positive**:
- The reset follows the owner's list and order, changes without a deploy, and has a dry run before it deletes anything.
- A new kind of portal object is found and removed without a code change, and the owner is told what it was.
- Identity, Users, and the protected items are impossible to delete from any path, including a discovered one.
- A crash, restart, or deploy mid run resumes safely, because every step is safe to run again.
- A failed or aborted reset is never silent: audit row, run record, and email.

**Negative / tradeoffs**:
- A headless Chromium in the worker image (several hundred MB, more memory during a run) and a Playwright dependency in production.
- The sign in depends on the portal and Authentik pages keeping their element ids; a page change makes sign in fail (loudly) until the selectors are updated.
- Per item records are kept 30 days in their own table, not in the permanent audit log, because the audit log is append only. The Audit Log shows only run level rows.
- Delete and record is aggressive on a portal the owner does not control. The extra guards (system flag skip, cap of 25, GET lists only, name correlation, related routes left alone, time limits) are mine, on top of the owner's decision, and can be relaxed.
- A guarded item that the list itself marks for deletion is silently kept, so a list can say "delete SSIDs" and still leave one, as intended.
- A deleted wired device can come back as Waiting for Approval after the reset (accepted by the owner), so `allowLeftover` exists for that one list.
- Two lanes mean a third lab ending at the same minute waits for a free lane; the 25 minute target is a target, and the stop check protects the next lab.

**Neutral**:
- The cleanup hook (spec 0021) is unchanged and independent. Decided 2026-10-27: the owner will not use an external system for reset, so the hook does not fire at a normal end and this feature builds no external call. The reset here is the only cleanup.
- The scope text for feature 24 changes: the audit line (D9) and the done when line now match this spec.
- The `portal_reset` audit area now holds both admin and system actions.

## Follow-up

- [ ] Owner answers (see the list in the hand over message). Defaults taken here are marked in the acceptance criteria and `rationale.md`.
- [ ] Resolved by review (2026-10-27): the portal gives Administrator from the Authentik group `NileWorkshopNAdmin` (the tenant's `access_group`, rule `memberOf` contains it), so `automation@` needs that membership and nothing in the portal's Users page. Still proven by the live check in AC-44 on Workshop 4 before the real sign in is relied on, and run by the build.
- [x] Provisioning role permissions (checked read only with the master token on 2026-10-27, authorised by the owner): `hol-webapp-provisioning` already holds `authentik_core.reset_user_password`, `add_user`, `add_user_to_group`, and `change_user`, and has no delete. Nothing was granted or changed. The permission is global in Authentik, so the guard in code (AC-42) is what limits it to the automation users. `admin@nileworkshop-4.com` was read too: internal, path `users`, not a superuser, in `NileWorkshop4Admin` and `NileWorkshop4Employee`.
- [ ] Capture, on a scratch tenant, the evidence the starting list still lacks (spec 0022 Follow-up): Service Profiles delete and system marker, PEAP delete, Guest Portal restore body, device group delete, the other SIEM vendors.
- [ ] (Partly done 2026-10-28, read only on Workshop 4 after a reset: all 16 list routes answer `200`; empty lists come back as `content(0)`, `array(0)` or `data` with no records; `/api/v1/client-configs` still holds 2 entries after a reset, so the 2 deletes on every repeat run are most likely the portal recreating them. Confirmed 2026-10-28: both are `INDIVIDUAL` devices (`00:e0:4c:68:56:39`, `02:1a:2b:3c:4d:00`) in state `AUTH_WAITING_FOR_APPROVAL`, stamped minutes after the last reset, so they are real devices reconnecting, not a recreated `ALL` rule; the owner already accepts this (findings, Wired). Segment test done 2026-10-28 on Workshop 4: `DELETE /api/v1/settings/segments/{id}` while a user group matched the segment answered `400` "<name> is still referenced" and deleted nothing, so the API refuses it and no `blockedBy` check is needed; the owner adds that a policy group can always be deleted, and a user, device, or app group in use by a policy group cannot. Not done: a tenant never set up or unlicensed.) While building: run the two by hand tests in Critical test scenarios (what each list answers when its feature is unset, and whether the API refuses a segment a policy group still uses). If the API accepts the delete, consider a generic `blockedBy` check in the language.
- [ ] Learn the portal token's lifetime. AC-17 assumes it can expire mid run and re-signs in once.
- [x] Run `00-discover-pages.mjs` once more and complete `discovery.json` `furniture` from its output before the first live run. (Done 2026-10-28 on Workshop 4: every list it shows after the furniture filter is already a step route or on the deny list, so `furniture` needs no new pattern.)
- [x] Cleanup hook at a normal lab end: decided no (2026-10-27). The owner uses no external reset system. The ENHANCE item in spec 0021 Follow-up can be closed as not needed.
- [ ] Later option: a form per part kind in the page; a mode per testbed; a Reset now button on a testbed; an HTTP only sign in (replacing the browser sign in behind the same `signIn` interface) if the Authentik flow API proves stable.
- [ ] `/sync`: update `server/authentik/AGENTS.md` (the one allowed non learner write, `guardPortalAdminWrite`) and add to `AGENTS.md` the engine rules (secrets only in `Secret`, one call choke point, no type names in `server/portal-engine/`, `server/portal-engine/AGENTS.md`), and the new env values to the commands and Docker notes.
- [x] **Branding restore did not work on a customised tenant (found and fixed 2026-10-28, Workshop 4).** Cause: `profile_name` must be the profile's own name (`<tenantId>_V1` once customised, `profiles` at the defaults), not the literal `profiles`; with that name the same call answered `204` and the profile went back to pristine. The step now reads the tenant id (`/api/v1/guestpop/advance`) and the profile name (`/api/v1/cloud-profile/map/{tenantId}`), calls with that name, and checks the name reads `profiles` after. Deployed and verified live 2026-10-29: the engine restored a customised Workshop 4 (after an early end) and a customised Workshop 1 (after Todd's lab), each profile going from `<tenantId>_V1` back to `profiles`. With the guest portal colours changed (profile `last_update` 2026-10-28), the engine's call `DELETE /api/v1/cloud-profile/value?profile_name=profiles&profile_type=app_profile&scope_type=tenant` answered `500` "Failed to Delete Profile Value" / `409 CONFLICT "The Operation is not allowed"` and changed nothing, which the step's `expectRefusals` reads as the expected default tenant answer, so the engine would report success and leave a learner's branding in place. The page's own Restore on the same tenant sent `DELETE /api/v1/cloud-profile/value` and got `204`; the profile went back to pristine (`name` `profiles`, `my_nile` values empty). Next: capture the page's full request (query, headers, body) on a customised tenant, fix the step, and make the post check read the profile instead of trusting the refusal.
- [ ] Found by the 2026-10-29 live runs, both left the run `incomplete`: (1) Workshop 4, step `policy-groups`: the user group `dfgdfgdf` answered `400 Cannot delete, Group belongs to a Policy`, so a policy that uses it was not deleted first (check the policies step against a policy the owner created); (2) Workshop 1, step `nile-radius-certificates`: the post check `config.tlsComplete eq false` failed after the key delete, so the Nile RADIUS TLS config was still complete.
- [ ] 2026-10-29: the deploy of sha-3099cbe started the worker from the small `reservations` image (no `playwright-core`), which crash looped for about 2 h 38 min until the worker was recreated from `reservations-worker`. Find why compose chose that image and guard `deploy.sh` (check the worker container's image after `up`).
- [x] 2026-10-29 Workshop 1 `nile-radius-certificates` failed `tlsComplete eq false` because a Nile RADIUS that was never set up has `eapTLSConfig: null`, so the read has no value. Factory default is null or `complete: false`; the check is now `tlsComplete ne true` (a missing value is not true). The stored step must be updated on the Nile Portal Reset page; a seed file change does not reach an installed step.
