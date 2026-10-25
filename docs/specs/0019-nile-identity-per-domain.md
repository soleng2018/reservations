# 0019. Nile identity per domain

**Date**: 2026-10-24
**Status**: In Progress

## Summary

Each Nile tenant is tied to an email domain, so a learner needs a login in the domain of the testbed they booked, such as `ana.souza@nileworkshop-1.com`. This spec keeps one Authentik user per learner (one password) and changes that user's username to the login for the booked domain whenever a booking or reschedule lands on a domain. The real email stays in the user's email field, so set password and notices still reach the learner. The login is `firstname.lastname@domain`, with a random number added only when the address is already taken. A small table remembers each learner's login per domain, so going back to a domain gives the same login.

## Context

> ⚠️ Premise note: the scope (amended 2026-10-22) described one Authentik user per learner per domain, each with its own set password email. That means a learner who books in two domains sets three passwords (one for this app, one per domain), and sign in, deactivation, and the group reconciler would all have to handle several users per learner. The owner chose a simpler framing on 2026-10-24: one user per learner, and only the username follows the booked domain. The scope entry for feature 20 was updated to match. This spec follows that choice.

Today a learner has one Authentik user. Its username is the lowercased real email, its email field is the real email, and it carries the `hol_learner` and `hol_user_id` attributes (spec 0003, `findOrCreateLearner` in `server/authentik/learners.ts`). The app links sign in to it by the Authentik user's numeric id (`users.authentik_user_pk`), not by username, and the access reconciler adds that same user to the testbed's group while a booking is Current (spec 0017). Spec 0017 gave every testbed a unique Domain, and spec 0018 gave it a friendly Name.

A learner holds at most one Upcoming or Current booking (spec 0010), so at any moment at most one domain matters for that learner. The testbed, and so the domain, comes from availability, so the next booking can land in a different domain.

The Nile attributes come from the `soleng2018/nile-idp` script (`scripts/nile_idp.py`): `mail`, `firstName`, `lastName`, and `mobile`. That script is not in this repo, so the attribute names here follow the scope and need a check by the owner (see Follow-up).

## Requirements

**User stories**:
- As a learner, I want a login in the domain of my lab, built from my name, so that I can sign in to that Nile tenant with an address that makes sense there.
- As a learner, I want to keep one password, even when I book labs in different domains.
- As an admin, I want to see which login a learner has for each domain.

**Acceptance criteria** (the contract, each independently checkable):
- **AC-1**: The login is built by one pure function in `lib/nile-login.ts` from the learner's `name`, their real `email`, and the testbed `domain`. The name is split on whitespace: the first word is the first name and the last word is the last name; one word means a first name only. Each part is lowercased, stripped of accents (Unicode decomposition, then marks removed), and reduced to the characters `a` to `z` and `0` to `9`, then cut to 30 characters. A last name that is empty after cleaning counts as absent. A first name that is empty after cleaning (for example a name written only in Chinese characters) falls back to the part of the real email before the `@`, cleaned the same way, with no last name. If that is also empty, the name part is `learner`, which always gets a random number. The whole username is at most 64 characters before the `@`. The plain login is `first.last@domain`, or `first@domain` when there is no last name. The name used is `users.name` (the stored name), never a value posted at that moment.
- **AC-2**: A clash is another Authentik user whose username equals the candidate (Authentik is asked by exact username), or another learner's stored login equal to it. The learner's own user and own stored login never count as a clash. The plain login is used when it is free. Only on a clash, a random whole number from 1000 to 9999 is appended to the name part, before the `@` (`ana.souza4821@domain`, or `ana4821@domain` for a first name only), and the 5 candidate numbers are drawn together and checked in one Authentik query set under a total time budget of 15 seconds, so the learner and testbed locks are not held for long. Admin users, and any other Authentik user, count as clashes like everyone else.
- **AC-3**: Each learner's login per domain is remembered in a new table (`learner_domain_logins`), at most one row per learner and domain. A booking or reschedule in a domain the learner already has a row for reuses that login without drawing again, even if the plain address has been taken by someone else since. A row is written once and never rewritten by a later booking; only its `used_at` time moves. If the row for this domain already has the learner's latest `used_at`, the function returns at once: no Authentik call, no audit row, nothing written. If a stored login has since been taken in Authentik by another user, the booking or reschedule is refused with `unavailable` and a `user.nile_login_conflict` audit row is written for an admin to resolve; the stored login is not redrawn.
- **AC-4**: When a booking is confirmed (the guest saga, including a signed in learner) and when a reschedule lands on a testbed, the learner's Authentik user is brought to the login of that testbed's domain: `username` is the login, `attributes.mail` is the login, `attributes.firstName` and `attributes.lastName` are the first and last word of `users.name`, and `email` is not touched. The user's other attributes (`hol_learner`, `hol_user_id`) are kept. `mobile` is not set. Nothing is written when the user already matches. The Authentik patch is the last step before the database commit; the previous username is kept from the guard read, and if anything fails after the patch the function renames it back (best effort, logged on failure). A learner who has never booked keeps their email as username until their first booking.
- **AC-5**: If Authentik is unavailable, the user is refused by the write guard, all 5 random numbers clash, or a stored login is taken (AC-3), the booking or reschedule is refused with the existing "try again shortly" outcome and nothing is saved: the guest saga compensates as it does today, and a reschedule rolls back so the old booking stays as it was. No email is queued for a login that was not set.
- **AC-6**: The learner sees the login in the booked, rescheduled, and reminder emails (a "Nile login" row in the details card and in the plain text copy), on the booking success and reschedule success screens, and on the reservation detail (the lab access card). It is read from `learner_domain_logins` by the booking's learner and testbed domain, at send time for emails (like `clientLoginsForBooking`), so it is never copied into `email_messages.details` or a job row. It is read with the same filters as `ownLabAccess` (the session learner's own booking, an active learner, a verified email, a confirmed or completed booking), and an email shows it only while the booking is still confirmed in that testbed's domain. A brand new learner, who has no verified email yet, therefore sees it only in the email. It reaches only the booking's own learner: a guest reply without a matching session never carries it, as with lab links (spec 0012). The cancelled email does not show it. A booking made before this change has no stored login, and its screens and emails simply omit the row.
- **AC-7**: The admin user detail page shows a read only "Nile logins" list: domain, login, and which one was last set by a booking (the row with the latest `used_at`, labelled "Last set by a booking", because it can differ from Authentik after a manual change). It shows no password. An admin read of the list is allowed only through `requireAdmin()`.
- **AC-8**: An admin email fix (`updateLearnerIdentity`) still sets `email`. It sets `username` to the new email only when the learner has no stored login; a learner with a stored login keeps their username and only the email changes. The "taken" check still looks at the new email against other users. The caller reads whether a stored login exists and passes it to `updateLearnerIdentity` as a flag.
- **AC-9**: Nothing else changes: one Authentik user per learner, app sign in, the set password email and link, deactivation and reactivation, session ending, and the access reconciler all keep working on the same user id. The reconciler needs no change. `findOrCreateLearner` finds a returning learner by `users.authentik_user_pk` when it is set, and by email only when it is null, so a renamed user is never missed or duplicated. The learner can still sign in to Authentik with their real email, which the owner confirmed on 2026-10-24 (see Follow-up). An anonymous guest booking with an existing learner's email also renames that learner's username; this is accepted, because sign in is by real email and by user id.
- **AC-10**: Two learners booked at the same moment with the same name never get the same login and never see an error: the stored row is inserted with `insert ... on conflict do nothing returning id`, and when no row comes back the loser draws again. A unique violation never aborts the transaction. The same learner booking twice at once is already serialized by the learner row lock.
- **AC-11**: Every login set or first stored writes an audit row (`user.nile_login_set`) in the same transaction as the stored row, with metadata `{ domain, username, numbered, changed }` (`numbered` is true when a random number was used, `changed` is true when the Authentik username changed). No password or secret is involved.
- **AC-12**: Only the booking flows (guest saga, reschedule) may call the function that sets the login, and it is guarded: it refuses admin users and users without the `hol_learner` attribute through `guardUserWrite(api, pk, "learner")`, as every learner write does.

## Options considered

### Option 1: One Authentik user per learner per domain (the scope as amended 2026-10-22)

Each domain gets its own Authentik user at `first.last@domain`, with its own set password email. A learner can have several users, each added to the group of its booking.

**Pros**:
- Every domain login is a stable, separate Authentik user. A tenant that matches on username never sees the name change.

**Cons**:
- One password for the app and one more per domain. Authentik keeps a password per user and the app never sees passwords, so it cannot share one.
- Sign in, deactivation, session ending, and the reconciler must all handle a list of users per learner, and the `users.authentik_user_pk` link stops being enough.
- More emails and more unused users.

### Option 2: One Authentik user per learner, the username follows the booked domain

Keep the one user. At booking and reschedule, set its username and `mail` attribute to the login for the booked domain, and remember each domain's login in a small table.

**Pros**:
- One password for everything. Sign in, deactivation, sessions, and the reconciler are unchanged, because the user id never changes.
- The app already links by user id, and an admin email fix already changes a username today, so the mechanism is proven.
- The one booking at a time rule means no live lab depends on the old username.

**Cons**:
- The old domain's login stops being the Authentik username once the learner books in another domain. A tenant that remembers the old login simply has an unused account.
- Learners can only sign in to the Nile tenant of their current booking's domain by its login.
- Needs owner side checks (identification stage accepts email, tenant SAML NameID uses the username).

### Option 3: One user, per domain logins stored as an attribute, tenant NameID reads the right one

Keep the username as the real email and store the logins in an Authentik attribute. The owner changes each tenant's SAML NameID mapping to read the login for that tenant.

**Pros**:
- The username never changes, and one password serves everything.

**Cons**:
- Needs an owner side change on every tenant's provider, which the app cannot make (the app never modifies existing Authentik providers).
- Not clear that each tenant's sign in flow works when the learner types a login that Authentik does not know as a username.

## Decision

**Chosen option**: Option 2: One Authentik user per learner, the username follows the booked domain.

At booking confirm and at reschedule, set the learner's Authentik username and `mail` attribute to the login for the booked domain, remember it per learner and domain, and leave everything else on the user alone.

**Implementation skills**: `kysely` (`mindrally/skills`, `.claude/skills/kysely/`) · `supabase-postgres-best-practices` (`supabase/agent-skills`, `.claude/skills/supabase-postgres-best-practices/`) · `zod` (`pproenca/dot-skills`, `.claude/skills/zod/`) · `vitest` (`antfu/skills`, `.claude/skills/vitest/`) · `react-email` (`resend/react-email`, `.claude/skills/react-email/`)

## Rationale

The forces in Context point one way. A learner holds one live booking at a time, so only one domain is in play at once, and the app links sign in by user id, so a username change cannot break sign in. That makes a rename safe and cheap, while Option 1 multiplies passwords, users, and code paths for a case the booking rule already rules out. Option 3 depends on owner changes the app is not allowed to make and on a tenant flow nobody has confirmed.

The owner asked that the username change when the learner books another domain. The spec adds one thing the owner did not state: a small table that remembers each domain's login. This is a recommendation. Without it, a random number could change between visits, and a plain address could be taken by someone else while the learner was away, so the learner would get a different login in a domain they already used. The table is small, additive, and easy to drop later.

The rename happens at booking confirm, not when the booking starts, so the booked email and the success screen can show the final login. Failing the booking when the rename fails (instead of booking now and retrying later) keeps the rule that a learner never receives a login that does not exist, at the cost of a retry for the learner when Authentik is down, which is already how booking behaves.

## Feature design

**Data model sketch** (migration `db/migrations/0015_learner_domain_logins.sql`, additive):

| Table | Column | Type | Notes |
|---|---|---|---|
| `learner_domain_logins` | `id` | uuid pk | `gen_random_uuid()` |
| | `user_id` | uuid not null | FK to `users(id)`, `on delete cascade` |
| | `domain` | text not null | lowercase; copy of `testbeds.domain` at first use |
| | `username` | text not null | the full login, lowercase |
| | `used_at` | timestamptz not null | set to `now()` each time this login is made the Authentik username |
| | `created_at` | timestamptz not null | default `now()` |

Constraints and indexes (names are kept stable for tests and later specs): `learner_domain_logins_domain_lower` (`domain = lower(domain) and domain <> ''`), `learner_domain_logins_username_lower` (`username = lower(username)`), `learner_domain_logins_username_domain` (`username like '%@' || domain`), `learner_domain_logins_user_domain_uq` (unique `user_id, domain`), `learner_domain_logins_username_uq` (unique `username`, which arbitrates a race through `on conflict do nothing`, so it needs no `mapConstraintError` entry). Row level security is enabled like the other `hol_app` tables. Relationship: one `users` row to many logins (at most one per domain). No backfill.

**State transitions**: none. A row is created once per learner and domain, and only `used_at` changes.

**API surface** (no new routes; two existing flows call one new server function):

| Function | Inputs | Output | Auth | Key errors |
|---|---|---|---|---|
| `nileLoginFor` (pure, `lib/nile-login.ts`) | name, email, domain, draw | `first.last@domain` candidate list | none | none |
| `ensureNileLogin` (`server/authentik/nile-login.ts`) | api, trx, learner id, authentik pk, name, email, domain | `Result<{ username, numbered, changed }, "unavailable" \| "refused">` | called only by the guest saga and `rescheduleOwnBooking` | `unavailable` (Authentik down or all 5 draws clash), `refused` (guard) |
| `nileLoginsForUser` (admin read) | user id | rows of domain, username, used_at | `requireAdmin()` | none |
| `ownNileLogin` (learner read) | user id, booking id | login or null | session learner's own booking only | every miss is null |

`ensureNileLogin` order: (1) read the stored row for (learner, domain); (2) if none, build candidates, check Authentik by exact username and the table, draw if needed, and insert the row with `on conflict do nothing returning id` (no row back means draw again); (3) set `used_at = now()` and audit in the same transaction; (4) as the last step before commit, read the user through `guardUserWrite`, remember its username, and patch `username`, `attributes.mail`, `firstName`, `lastName` only when they differ. If the patch reports the username taken, draw again once more within the budget. Any failure after the patch renames the user back. The guest saga calls it inside the confirm transaction; a reschedule calls it inside its transaction after the new testbed is chosen, so a rollback of the reschedule renames back.

**Value sourcing**:

| Action | Value produced / displayed | Source |
|---|---|---|
| Build login | first and last name | `users.name`, first and last word |
| Build login | fallback name part | `users.email` before the `@` |
| Build login | domain | `testbeds.domain` of the assigned testbed (`StartedBooking.testbedId` in the saga; the chosen candidate testbed in a reschedule) |
| Clash check | taken usernames | Authentik `users.list` by exact username, plus `learner_domain_logins.username` |
| Random number | 1000 to 9999 | drawn by the server; a function argument so tests can fix it |
| Set username | Authentik user id | `users.authentik_user_pk` (the saga's `pk` from `findOrCreateLearner`) |
| Set attributes | `mail` | the login; `firstName` and `lastName` from `users.name` |
| Email and screens | Nile login row | `learner_domain_logins` joined on booking `user_id` and testbed `domain`, read at send time |
| Admin list | domain, login, in use | `learner_domain_logins` (latest `used_at` is in use) |
| Reschedule | the learner's Authentik pk and name | `users` row, locked in the reschedule transaction |

**Key invariants**:
- A learner has one Authentik user; its pk never changes because of this feature.
- A stored login is never rewritten; the same learner and domain always give the same login.
- `username` and `mail` always match after a successful booking or reschedule.
- No login, password, or Authentik id appears in `email_messages.details`, a job row, a log line, or the cancelled email.
- A stored login row is written only inside the confirm or reschedule transaction, so the saga undo can still delete a new learner.
- A `hol_learner` check and the admin refusal are the guard's job; this feature adds no write path that skips `guardUserWrite`.

**Security model**: Only the guest saga (after step 1 has checked admin and deactivated rows) and a signed in learner's own reschedule can set a login. An admin can read the list; a learner reads only the login of their own booking, with the same "every miss is missing" rule as `ownLabAccess`. A login is an address, not a secret, but it is still shown only to its own learner. No compliance scope beyond the personal data the app already holds (name and email).

**Configuration required**: none. No new env vars.

**Critical test scenarios** (each maps to an acceptance criterion):
- Pure function: `Ana Maria de Souza` gives `ana.souza`; `Prince` gives `prince`; `José O'Neil` gives `jose.oneil`; a name with no letters falls back to the email part; 30 character cap, verifies **AC-1**.
- Clash: plain address taken in Authentik gives a numbered one; taken in the table gives a numbered one; the learner's own username is not a clash; five clashes in a row return `unavailable`, verifies **AC-2**, **AC-5**.
- Same domain again changes nothing and writes nothing; back to an old domain reuses the stored login even when the plain address is now taken, verifies **AC-3**.
- Guest saga: a new learner ends with username, `mail`, `firstName`, `lastName` set, `email` kept, other attributes kept; the booked email shows the login, verifies **AC-4**, **AC-6**.
- Reschedule onto a testbed in another domain renames; an Authentik outage rolls the reschedule back and queues no email, verifies **AC-4**, **AC-5**.
- Two saga runs with the same name at once: different logins and no thrown error, verifies **AC-10**.
- Learner screens and emails: another learner's booking id gives nothing; the cancelled email has no login row; a pre change booking omits the row, verifies **AC-6**.
- Admin email fix keeps the username when a login exists, sets it when none, verifies **AC-8**.
- Audit row written once per set, in the same transaction, verifies **AC-11**.
- Admin and unlabelled Authentik users are refused by the guard, verifies **AC-12**.
- Reconciler and deactivation tests still pass unchanged, verifies **AC-9**.

## Build plan

Tracer Bullet: one thin thread through every layer first (a new guest booking ends with a login in Authentik and in the booked email), then each strand.

1. [x] Pure `lib/nile-login.ts` (split, clean, candidates, draw as an argument) with plain input and output tests, satisfies **AC-1**, **AC-2**
2. [x] Migration `0015`, `npm run db:codegen`, `user.nile_login_set` and `user.nile_login_conflict` in `lib/audit-actions.ts`, satisfies **AC-3**, **AC-10**, **AC-11**
3. [x] Thin thread: `ensureNileLogin` in `server/authentik/nile-login.ts`, called from `bookAsGuest` inside the confirm transaction, and `findOrCreateLearner` reuses the stored pk; the booked email template and its reader show the login row, with the fake Authentik asserting the writes, satisfies **AC-3**, **AC-4**, **AC-5**, **AC-6**, **AC-12**
4. [x] Reschedule: pass the Authentik client into `rescheduleOwnBooking`, call `ensureNileLogin` for the chosen testbed's domain inside the transaction as its last step, refuse and roll back (with rename back) on failure; the rescheduled email shows the row, satisfies **AC-4**, **AC-5**, **AC-6**
5. [x] Remaining surfaces: reminder email, booking and reschedule success screens, the lab access card via `ownNileLogin`, the admin user detail "Nile logins" list, satisfies **AC-6**, **AC-7**
6. [x] `updateLearnerIdentity`: keep the username when a login exists, satisfies **AC-8**
7. [x] Regression and proof: reconciler and deactivation unchanged, a pre change booking omits the row, a source scan that only the booking flows call `ensureNileLogin`, satisfies **AC-9**, **AC-10**, **AC-12**

## Consequences

**Positive**:
- One password per learner, whatever domains they book.
- The reconciler, deactivation, sign in, and set password code do not change.
- The learner gets a Nile address that reads like their name.

**Negative / tradeoffs**:
- The Authentik username is no longer the real email after the first booking. Anything that assumed `username = email` must be checked (`findOrCreateLearner` already finds learners by email field, and `updateLearnerIdentity` is changed here).
- After a learner books in another domain, their old domain login is no longer an Authentik username. The tenant's account for it sits unused.
- A reschedule now calls Authentik while holding its row locks, as the other learner changes do (spec 0008 lock first pattern), so an Authentik outage now also blocks a reschedule onto a new domain.
- One more table and one more audit action.

**Neutral**:
- Accounts created before this change keep `username = email` until their next booking, and earlier bookings show no login row.
- Spec 0003's rule "new learners: username = lowercased email" now describes only the first step of the saga; the saga then renames the user.

## Migration plan

**Strategy**: no migration needed for data. The table is additive and starts empty.
**Phases**:
1. Owner's Authentik check is confirmed (see Follow-up), then deploy migration `0015`, then the web and worker together (the worker's reminder job reads the table). Done 2026-10-25: image `sha-1a8920b` deployed with `scripts/deploy.sh`; `0015` was already applied on the shared database.
2. Learners get a login at their next booking or reschedule. No script, no backfill.
**Rollback**: revert the code and drop `learner_domain_logins`. Usernames already changed in Authentik stay as they are; sign in is by user id, so nothing breaks, and the app keeps working with the real email as the email field.
**Risks**: an Authentik outage at booking time blocks the booking (as today). Two tenants that rely on the username in their SAML NameID need the owner's check before the first real booking (see Follow-up).

## Who owns what: this app and the `nile-idp` script

The `soleng2018/nile-idp` script (`scripts/nile_idp.py`, tenant files `tenants/<domain>.toml`) builds the Authentik to Nile Portal federation. This app only uses what it builds.

| Piece | Owner | Notes |
|---|---|---|
| SAML provider, application, signing keypair, the `Nile:` property mappings (including `Nile: NameID login`), the `nile-authorization` flow | `nile-idp` | Shared mappings are updated in place by `apply`. This app never modifies an existing provider or mapping. |
| SCIM provider, its hidden application, SCIM key file | `nile-idp` | A tenant without a SCIM provider has nobody provisioned into Nile. Learner sign in itself goes through SAML and needs the tenant's active Nile group mapping, not SCIM. |
| Marker groups (`NileWorkshopNAdmin`, `hol_testbed_group`) | `nile-idp` and the owner (spec 0017) | The app only reads groups and changes membership. |
| Nile Portal side: add provider, group mapping and rule (set ACTIVE), verify domain | owner, by hand | The script prints a checklist only. A learner gets "no access" until the tenant's group rule is active. |
| Learner Authentik user, username `first.last@domain`, `attributes.mail` set to that login, group membership, deactivation | this app | `server/authentik/nile-login.ts`; the table `learner_domain_logins` remembers each domain's login. |
| Nile login shown to the learner (emails, success screen, lab card, admin user detail) | this app | |

**Contract between them**: the script's NameID and `Nile: mail`/`Nile: email` mappings read `attributes.mail`; this app writes it. The NameID fallback is meant to be the username, never `user.email`; that change is in `nile-idp` PR #1 and is live only after the owner runs `apply`. If either side changes the attribute name, change both. A new tenant is a script run plus the Nile checklist, then an admin adds a testbed with that domain and group name; no app change.

**Not covered by the script**: SCIM sync timeouts (`ResultTimeout` in the Authentik event log on tenants 1 to 4) are an Authentik or Nile side issue. `verify` reports sync status but cannot fix it. It does not block learners, who get in through SAML.

## Follow-up

- [x] Attribute names checked 2026-10-24 against `soleng2018/nile-idp` `scripts/nile_idp.py`: `mail`, `firstName`, `lastName`, `mobile` are right. The script also sends an `email` attribute that reads `attributes.mail` first, so it carries the login too. `mobile` defaults to an empty string, so leaving it unset is fine. The owner confirmed on 2026-10-24 that each tenant accepts an empty `mobile`. Nile decides admin by Authentik group name: `NileWorkshop1Admin` maps to Nile's Administrator role. That is a Nile side rule on group membership, and this app never adds learners to such a group (spec 0017 limits it to the marker groups of testbeds).
- [x] Owner confirmed 2026-10-24: the Authentik sign in accepts either the username or the real email with the same password (checked with a Nile admin user whose email differs from the username, and again with a Playwright run: username `admin@nileworkshop-1.com`, email changed to `dummy@test.com`, signing in to Authentik with `dummy@test.com` reached the user library). So a learner with the username `jane@nile-workshop-1.com` signs in to this app with `jane@acme.com`, and uses the domain login for Nile assets (Nile Portal, Cloudflare client access).
- [x] **Blocker before the first real booking**, owner: **fixed and verified 2026-10-24 for all four tenants, one choice left.** Nile routes logins by the domain of the SAML NameID, and the old `nile-idp` setup sent `user.email` (the real address), which failed with "Nile cloud services encountered an unknown error" (tested with email `dummy@test.com`). The `nile-idp` script (commit `ee14ddc`) now creates the mapping `Nile: NameID login` (`attributes.mail`, falling back to `user.email`) and points each provider at it. The four workshops were re added from the script: providers 21 to 24 all use that mapping, `preview_user` returns the domain login as the NameID, and a Playwright sign in from `u1.nile-global.cloud` as `admin@nileworkshop-N.com` reached each tenant dashboard (N = 1 to 4). This app writes `attributes.mail` with the login (`server/authentik/nile-login.ts`), so the fallback is not hit for learners it renames. Open choice for the owner: change the fallback from `user.email` to `user.username`, so a user with no `attributes.mail` never sends the real address. Recommended. Not yet tested: a learner whose email differs from the username on the re added providers (the earlier `dummy@test.com` test ran on the old provider with the same expression). Update 2026-10-25: the owner chose the `user.username` fallback; it is in `nile-idp` PR #1 (`fix/nameid-fallback-username`), and takes effect when the owner runs `apply` for any one tenant (the mapping is shared). All five tenants are in scope, not four (see the tenant 5 note below).
- [x] Learner isolation fixed 2026-10-24 by the `nile-idp` script: the four Nile providers (pk 21 to 24) now authorize through its own flow `nile-authorization` (no stages, no policy bindings), so `hol-learner-isolation` no longer applies to them. Verified: a `hol/learners` user in `NileWorkshop1Admin` with a different real email reached the Workshop-1 dashboard with no consent click; a `hol/learners` user not in the tenant's group got Authentik's "Permission denied". Each Nile application keeps its own group binding, which is what keeps other learners out.
- [x] Live test result 2026-10-24: four test learners made with the app's own code (`findOrCreateLearner` then `ensureNileLogin`, real Authentik, DB rolled back): Dana Reyes got `dana.reyes@nileworkshop-1.com`, Émile Dupont-Martin got `emile.dupontmartin@nileworkshop-2.com`, Priya Nair got `priya.nair@nileworkshop-3.com`, Li Wei Chen got `li.chen@nileworkshop-4.com`, each with a different real email. With the isolation block bypassed, Dana, Priya and Li reached their tenant dashboards. Émile reached Nile but got "You do not have access to the requested resource" (twice). His Authentik data has the same shape as Dana's, and the tenant 2 admin signs in fine, so the cause is likely the accent or hyphen in his name on the Nile side. Not yet diagnosed. Superseded by the two notes below: tenant 2 and 5 were Nile side setup, now resolved.
- [x] Tenant 2 learners fail, and it is not the name: re tested 2026-10-24 on the new providers with `Emile Dupont-Martin`, `Émile Dupontmartin` and `Émile Dupont-Martin`, in the Admin group, and Admin plus Employee: all reach Nile and get "You do not have access to the requested resource". Learners on tenants 1, 3 and 4 get in, and `admin@nileworkshop-2.com` gets in. Authentik side data is the same shape as the working users (NameID, `mail`, `memberOf`). So the cause is on the tenant 2 Nile side, likely the user is not provisioned there (SCIM) or a role mapping is missing. Owner: check Nile tenant 2 for a learner created after the re add, and its SCIM sync. Resolved, see the next note.
- [x] Tenants 4 and 5 tested 2026-10-24 the same way: a tenant 4 learner (`li.chen@nileworkshop-4.com`, real email different) reached the dashboard; a tenant 5 learner (`sam.okafor@nileworkshop-5.com`, in `NileWorkshop5Admin`) got the same "no access" as tenant 2. So learners get in on tenants 1, 3 and 4 and fail on 2 and 5. Retested with the Nile portal password: `admin@nileworkshop-2.com` signs in to Nile, `admin@nileworkshop-5.com` gets the same "no access" as the learners. Tenant 5 has an Authentik SAML provider (pk 29) but no SCIM provider (only pk 25 to 28 exist), so nobody is provisioned into Nile for it: that is the cause for tenant 5, and it is not a learner problem. Tenant 2 has a SCIM provider, its admin works, but new learners do not. The Authentik event log shows `scim_sync` tasks timing out (`ResultTimeout`) on tenants 1, 2, 3 and 4 alike, so a slow or failing SCIM push is the likely reason a new tenant 2 learner is not in Nile yet. Owner: check why SCIM sync times out. Update after the owner activated tenant 5 in Nile: a fresh tenant 5 learner (`sam.okafor@nileworkshop-5.com`, real email different, in `NileWorkshop5Admin`) now reaches "Nile Workshop 5's dashboard", so tenant 5 works for learners. `admin@nileworkshop-5.com` still gets "no access" although its Authentik data matches the working tenant 2 admin (same groups and attributes), but it works once the owner activated it in Nile (the owner's browser, then a rerun here): all five tenant admins now sign in. Tenant 2 learners are resolved: the owner had not yet activated the `NileWorkshop2Admin` group mapping in Nile. After activation a learner whose login has a period (`ravi.menon@`, kept after a username edit to `ravimenon@` and back, and a brand new `nora.quinn@`) signs in on tenant 2 at once. So the period is not a problem and no user update is needed. The earlier tenant 2 admin only worked because its username was already in Nile's user table. Learners on every tenant need the group mapping activated in Nile first. Test users deleted afterwards. All five tenants verified 2026-10-24; test users deleted.
- [x] Cleanup 2026-10-24: the four test users (Authentik pk 151 to 154) were deleted after the test, and no test mapping is left. The only NameID mapping now is the `nile-idp` script's `Nile: NameID login`.
- [ ] After the build, `/sync` should add the `learner_domain_logins` rules to `server/authentik/AGENTS.md` and the login read rule to the root `AGENTS.md`, and note in spec 0003 that the saga now renames the user.
- [x] Scope feature 20's "Done when" still describes several users per learner; it is rewritten by this step.
