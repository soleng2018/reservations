# 0023. Nile Portal reset engine: rationale

The decision record for [index.md](index.md). The build contract is there; this file holds the why.

## Context

After every lab, the owner wants the workshop's Nile Portal returned to a clean baseline so the next learner starts on an empty tenant. Spec 0020 already leaves a 30 minute gap after each lab. Spec 0021 sends a signed call only when a lab ends early, to an outside receiver, and nothing at a normal end. In the second round of requirements (2026-10-26) the owner changed course: the app now owns the steps and their order (spec 0022), and the engine runs them itself instead of a separate receiver.

The research on a live tenant (2026-10-27, decisions D1 to D17) settled what the reset does and many rules about how: the run order (D17), the shared password and what a failed sign in does (D5), what is audited and emailed (D9), that nothing to delete is a success (D10), the never touch pages (D14), that the Guest Portal branding is always restored (D15), and that the engine discovers lists instead of hard coding types (D16). It also left questions this spec has to close: where the engine runs, how it signs in without a person, what a failed sign in does besides stop, how a lab that starts during a reset is protected, how per item records fit an audit log that cannot be edited, and how discovery stays safe when it deletes things it was not told about.

The engine deletes data on tenants the app does not own, using an account shared by five workshops. A wrong target, a wrong tenant, or a reset that runs into the next lab is hard to undo. That is why the spec buys safety in layers and defaults the mode to `off`.

## Options considered

### Where the engine runs

#### Option 1: Lanes in the worker process, resumable runs in the database (chosen)

The worker starts a small number of run loops beside its tick. Each claims a due run with `FOR UPDATE SKIP LOCKED`, holds a lease while it works, and stores progress so a restart resumes.

**Pros**:
- Reuses the worker, its advisory lock, its image, its secrets mounting, and its shutdown handling.
- Runs of up to 25 minutes do not hold up the access reconciler, because they are beside the tick, not inside it.
- State in the database survives a crash or a deploy; the database clock decides timing.

**Cons**:
- A deploy during a run interrupts it (it resumes after, from the start of the interrupted step).
- The browser and the reset share the worker's memory.

#### Option 2: One step inside the worker tick

The tick gets a "portal reset" step like the cleanup hook step.

**Pros**:
- No new loop; the same shape as the other steps.

**Cons**:
- A tick step has a 60 second timeout and blocks every later step, including the access reconciler that grants and removes lab access. A 25 minute run in the tick would stall access for everyone.
- Slicing a run across ticks needs the token between slices, and the token must never be stored.

#### Option 3: A separate container for the reset

A new service in the compose file runs the engine.

**Pros**:
- Isolates the browser and the long runs from the worker.

**Cons**:
- A third image or target, a second lock, a second place for secrets and the abort email logic, and one more thing to deploy and watch. The owner already ruled out the separate receiver idea as the lead option.

### How it signs in without a person

#### Option 1: Headless Chromium for sign in and discovery, plain HTTP for everything else (chosen)

The prototypes already do the sign in this way and it is tested on Workshop 4. The same browser, with the saved session, loads the pages for discovery.

**Pros**:
- Proven. Discovery needs a real page load anyway (D16), so the browser cannot be avoided.
- Follows the portal and Authentik pages as they change, within the selectors.

**Cons**:
- Chromium in the worker image; element ids can change and break the sign in.

#### Option 2: Replay the OIDC and Authentik flow over HTTP

Drive the Authentik flow executor and the portal's code exchange with plain requests.

**Pros**:
- No browser for the sign in; smaller and faster.

**Cons**:
- Not researched: the flow, the PKCE and state handling, and how the portal turns the code into its `x-id-token` and `x-nile-client` headers were never captured. It would still need the browser for discovery. Kept behind the same `signIn` interface as a later option.

### Where per item records live

#### Option 1: Their own table with 30 day retention, plus run level rows in the audit log (chosen)

**Pros**:
- Honours "about a month" retention without touching the append only audit log (spec 0002 AC-7 and spec 0016 AC-11 forbid updates and deletes of `audit_events`, and a scan test enforces it).
- The permanent log still shows every run, every sign in failure, every safety stop, and every new route.

**Cons**:
- The Audit Log page does not show individual deleted items; the Recent resets page does.
- This is a narrower reading of "every delete is an audit row".

#### Option 2: Every item as an audit row, with a retention carve out

Allow the purge to delete rows of `portal_reset.item_*` actions older than 30 days.

**Pros**:
- Everything in one log, as the scope says.

**Cons**:
- Weakens the append only guarantee for one family of rows, changes spec 0002's trigger and spec 0016's scan test, and can fill the log with hundreds of rows per lab. Kept as the option if the owner insists.

#### Option 3: Items kept forever in the audit log

**Pros**:
- Simplest; nothing to purge.

**Cons**:
- Contradicts the owner's one month retention, and the log grows with every lab.

## Rationale

**Lanes beside the tick.** The access reconciler is the one worker step learners feel; it must never wait for a portal. Lanes beside the tick keep it free, and a lease plus stored progress make a run survive the things that actually happen to a worker (a deploy, a crash). The advisory lock the worker already takes means two worker processes cannot both run lanes. Lanes default to two because the five workshops can end at the same time (a booking ends on the hour), a run is mostly waiting on the network, and two browsers fit in the container; a third waiting run still has about ten minutes to spare inside the 25 minute target. The number is an environment value, so the owner can raise it.

**The stop check before every write.** The strongest protection for the next learner is not the clock but the data: the database knows whether a lab is Current or about to start on the testbed. One cheap query before every write (which also renews the lease) turns the 25 minute target into a soft target and the next booking into the hard limit. The 2 minute margin covers the time between a lab starting and the learner reaching the portal. The 2 hour hard cap is a backstop against a run that goes on forever on a testbed nobody books.

**Mode off by default, dry run.** The owner did not ask for a mode, but the scope's open questions listed a dry run, and a first live run of an engine that deletes on a tenant it cannot undo should be read only. A mode on the page costs one column and one select, is audited, and is the owner's off switch. Switching `live` takes a second confirm. The normal end scan looks back 45 minutes and no earlier than the last mode change, so turning the engine on does not reset labs that ended before.

**The app owns one account per workshop and a new password every run.** The first design (decision D5) used one shared password from a file, and a rejected password could lock all five workshops. The owner's direction is that the app owns the credential and no admin handles it. The simplest way to own a password safely is to never keep it: before each sign in the app sets a new random password on the workshop's own Authentik user, `automation@<domain>`, uses it once, and forgets it. That removes the file, the compose secret, the encrypted column (and an exception to the rule that ciphertext columns live only in the API keys code), the shared lock risk, and any wrong password, because the password is right by construction. Each workshop has its own account, so one problem stays in one workshop. If Authentik refuses (down, permission, policy, a disabled user) the run is held, the owner is emailed at once, and it is retried when no lab is active and 30 minutes passed. A transient failure (the browser did not start, the portal was slow) gets one retry after 20 seconds. The cost is one Authentik write per run and a first write that creates a user. Both are confined by `guardAutomationWrite`: create or set password, only for `automation@` plus a live domain, only for a user that does not exist or that the app marked itself, never an admin or superuser. The audit actions are `portal_reset.sign_in_failed`, `portal_reset.credential_failed`, and `portal_reset.automation_user_created`.

How a user becomes a portal administrator was the open risk, and the `nile-idp` setup answers it (reviewed 2026-10-27). Each tenant has an Authentik access group (for example `NileWorkshop4Admin`) that carries `hol_testbed_group` and `hol_testbed_domain`, the same group the app already uses for the testbed. The tenant's SAML application is bound to it, and the portal has a group rule that gives Administrator when the SAML `memberOf` contains that group name. `admin@<domain>` is just an internal user in that group with `attributes.mail` set to its username. So `automation@<domain>` needs exactly that: the same shape, in the same group. The access reconciler only removes members tagged `hol_learner`, so the untagged automation user is never removed. The live check in AC-44 still proves it end to end on Workshop 4 before the engine relies on it.

Alternatives for the password, kept: a stored password per workshop, encrypted with the existing keyring (works, but needs a new ciphertext column and keeps a secret at rest the app does not need); one shared password from a file (the first design, rejected for the shared lock risk and the admin setup).

**Deny list and guards as repo data, checked at the one choke point.** D14 says the guard must hold "independent of the saved list", and D1 says the protected SSID guard is "not an optional setting". Putting both in repo files, applied in the one function that sends every call, means a bad step, an edited database row, a resumed run, and a discovered route all meet the same check. The deny list refuses every method, not only writes (the research allowed plain reads): the engine has no reason to read Identity or Users, and refusing all is simpler to prove. The guard check works from ids read at the start of the run, not from names, and from the delete route prefix, not from the step, so a differently written step cannot go around it. An `expectKept` count (exactly one protected SSID) catches a broken assumption before any write, as the research run did by hand.

**Silent versus loud.** D9 and D10 make the rules: system items, empty steps, already gone items, and expected refusals are quiet; everything else is loud. The spec keeps the two apart in code: a reply classification table (AC-21) with a closed set of outcomes, a guard refusal that is never an error, and a deny list attempt that is a bug and a stop. An unresolved failure is emailed with the portal's message; one that the second pass fixed stays in the records but is not emailed, because an email for a recovered blip teaches the owner to ignore the emails.

**Redaction by construction.** The rule "never log the password, token, URL, key, or the portal's reply" is easier to keep with types than with care. Secrets live only in a `Secret` wrapper that prints as `[redacted]`. A record accepts only a branded `RedactedText` that `redactMessage` makes. A label is only the `labelField` of a list, so a webhook's URL or a recipient's address is never copied because nothing but the id and the label is ever read out of a listed record. Scan tests close the gap that types cannot: no `console`, no reply body or header handed to a recorder.

**Discovery as an algorithm over data.** The owner wants new types found without a code change and no type names in code (D16). The algorithm (collect, filter, confirm by name, derive the route by convention, verify by re-reading) has no type in it. Everything that is about a particular portal (pages, furniture, excluded routes, system flag field names, label fields) is data in the steps and in `discovery.json`. A scan test keeps the type names out of the engine files. "Delete and record" is the owner's decision (D16), and it is followed. Because it deletes things nobody listed, the spec adds guards of its own and flags them as additions: a presumed system item (a true flag such as `isDefault`) is skipped, a route over 25 records is reported and not deleted, only lists read by `GET` are deleted, a related route (one path a prefix of another, like a webhook's subscriptions under its config) is left alone, a candidate must be confirmed by its names on the page, and discovery stops after a time budget. The first live runs with the owner present on the scratch tenant are where these get tuned.

**Per item records in their own table.** The audit log is append only by trigger and by a scan test, which the owner and spec 0016 both rely on. The "about a month" retention cannot coexist with that for the same rows. Splitting the records keeps the guarantee and the retention: permanent rows for what an auditor needs (a run happened, a sign in failed, a safety stop, a route was found), and a 30 day table for the detail that is useful for a month and noise after. This is the one place the spec reads the scope's "every delete is an audit row" narrowly; the owner decides in the hand over list whether to accept it.

**Pure core, thin edges.** Rules, templates, path resolution, reply classification, redaction, and discovery filters are pure and tested with plain input and output. The interpreter takes a portal interface and a stop check, so one code path runs against the real client and the in memory fake. Side effects (the browser, HTTP, the database, the job queue) sit in `sign-in.ts`, `client.ts`, `claim.ts`, `report.ts`, and `queue.ts`. That follows `AGENTS.md` and lets the 13 steps be proven against the fake without a tenant.

The recommended pick for the other small calls, with the runner up in brackets:
- Retries: 3 attempts per call with 2 and 6 second waits, then the second pass. (Runner up: more attempts with longer waits; rejected, the 25 minute target is tight.)
- Fresh browser context per page for discovery, with the in memory session state. (Runner up: a new sign in per page; rejected, 14 sign ins per run.)
- A report email as a job, built from the run at send time. (Runner up: send from the run's transaction; rejected by the repo rule that the web and the run path queue, the worker sends.)
- Final re-read after discovery, then one second pass, then a last re-read. (Runner up: a re-read after each step; rejected, slower and it duplicates the second pass.)
- Wired leftovers: `allowLeftover` on that one part, because a deleted device can reappear as Waiting for Approval (accepted by the owner).
- A list whose `itemsAt` is not an array on a `200` is a loud failure, while a `404` is quiet. (Runner up: treat any odd shape as empty; rejected, a portal change would then hide failures.)
- 403 on a read is a failure, not "nothing to do", until the owner says an unlicensed feature answers 403. (`emptyOn` per list can add it.)

## References

**Project sources**:
- `docs/research/nile-portal-reset-findings.md` (D1 to D17, section 4 and 5) and `db/seed/portal-reset-starting-list.json`
- `docs/research/portal-scripts/` (sign in selectors, the discovery prototype, the tested logic per step)
- `AGENTS.md` (functional style, `Result`, Zod at boundaries, the database is the clock, secrets rules, audit in the same transaction)
- `server/worker/AGENTS.md` (the tick, the lock, the shutdown rule) and `server/jobs/AGENTS.md` (jobs, queue never call)
- Specs 0002 (append only audit), 0013, 0016, 0020, 0021, 0022

**Practices & standards**:
- Leases with `FOR UPDATE SKIP LOCKED` for a resumable work queue in Postgres
- Idempotency keys for queued work
- Defence in depth for destructive operations: a mode switch, a deny list, a protected set, a stop check, and a dry run
- Secrets handled by type (a wrapper that cannot print) instead of by discipline
