# Scope: Nile Hands-On Labs Reservations

A web app for Nile Hands-On Labs. Admins manage the remote lab catalog (testbed types, testbeds, API keys, and lab users). Learners book a remote testbed for a set time in three steps, then manage their bookings and open their lab access. Both views are designed in `context/reservations_mock.html`. The mock's Customer / Admin switcher (its "Customer" view is the learner view) is only there so both views can be seen in one file. It is not a feature of the app, where the role a user signs in with decides which area they see.

**Build approach:** Tracer Bullet (prove one real thread through every layer first, then thicken it one strand at a time).
**Workflow:** Medium (after `/develop`: `/check verify`, then `/test`). The project default rigor tier; architect still gates any feature that needs a decision at every tier; a feature's own tier tag (e.g. `· Full`) overrides it.

Decisions already made by the product owner (inputs for `/architect`, not open questions):
- Sign in for both admins and learners goes through one self hosted **Authentik** identity provider: the same instance and one OIDC application for both roles, with admins and learners told apart by role. The app talks to the Authentik API to configure itself and to create, update, and deactivate learners.
- The owner supplies two Authentik API keys, kept out of the app's database and UI:
  - a **master key**, used only to set up the app's OIDC SSO configuration in Authentik (provider, application, and anything else sign in needs).
  - if Authentik allows it, a separate **provisioning key** limited to learners: create, update, and deactivate learners, create and remove testbed groups (amended 2026-10-22: the app no longer creates or removes groups, see the last decision below), add and remove learners in those groups, and any other learner or testbed group task the app needs, but nothing that touches admins or the app's own sign in configuration. The app uses it for all day to day user calls and never uses the master key for them. If a key that narrow is not possible, `/architect` records the fallback and its risk.
- Admin accounts (username and password) are set up directly in Authentik by the owner. The app does not onboard, create, or manage admin users; it only recognizes an admin at sign in. How the admin role is recognized from Authentik is for `/architect` to settle.
- The admin console is reached only through an unlisted URL (e.g. `https://hol.mydomain.com/l0gin`). No page in the app links to it, and there is no admin sign up or sign in button anywhere. The unlisted URL only hides the console. It does not secure it: every admin page and API still requires an Authentik admin sign in.
- That URL opens the admin sign in page from the mock: a single "Sign in with SSO" button that sends the admin to Authentik, with no username or password form in the app. Sign out sits at the bottom of the admin sidebar. The mock's SSO button points at a Microsoft login URL only as a placeholder; the real target is Authentik.
- Guest booking, as in the mock: a new learner enters name, company, email, lab type, and timezone, picks a time, and confirms. On confirm the app creates the user in Authentik and emails a link to set a password, which also verifies the email. The mock's generated password shown on screen is replaced by that link. Learners then sign in through Authentik to manage bookings. Admins can also add learners from the console.
- Lab access (portal, LMS, client links) is shown right after booking and on Current booking details, as in the mock, to a learner whose email is verified. On Past booking details the links are greyed out and cannot be clicked, with a note that the reservation has ended and access is no longer active, as in the mock. How the success screen reads before verification is for `/architect` to settle.
- Booking rule: the learner picks a testbed type and a free 30 minute start time on a calendar; the system assigns a free testbed of that type for the type's duration. A testbed never has two overlapping bookings. A learner holds at most one Upcoming or Current booking at a time.
- Learners can cancel or reschedule an Upcoming or Current booking (cancelling a Current one ends it early). Times are stored in one universal form and shown in the learner's chosen timezone, and in the admin's own timezone in the console.
- API key secrets are write-only: an admin enters a secret once, it is encrypted at rest, and it can never be viewed, revealed, or copied again from the app, not even by admins. To change it, an admin replaces it with a new one.
- Emails in this release: set password / welcome, booking confirmation with a calendar invite (book, reschedule, cancel), and a reminder before start.
- The booking email follows `context/Nile HOL Lab Access Email Standalone.html`, the email-client-ready version of the mock's template (the success screen's "View email"): a hidden preview line ("Your lab is reserved. Access links and session details inside."), Nile logo, a "Your lab access is ready" heading, a note that the links work only from start time until the session ends, a details card with lab type, testbed, start and end in the learner's timezone, a "Lab access" list with the Portal, LMS, and one link per client, a "Set your password" note (a separate email brings the link; existing users sign in with their current credentials), a "Manage my reservation" button, the one active reservation rule, and the Nile footer. Its subject is "Your Nile Hands-On Lab access - <start>". On reschedule the same template is used with the mock's "Your reservation was rescheduled" heading and the subject prefixed "Updated: ". As with cancellation, this template is the body of one message that carries the calendar invite (new or updated), not a separate invite and email.
- The cancellation email follows `context/Nile HOL Cancellation Email Standalone.html`, the email-client-ready version of the template the mock shows after a learner confirms a cancel: a hidden preview line, Nile logo, a "Your reservation was cancelled" heading, a note that the testbed is released, the calendar event removed, and the access links no longer work, a details card with lab type, testbed, "Was scheduled" and "Until" times in the learner's timezone, a "Reserve a new lab" button, and the Nile footer with a nilesecure.com link. Times read like "Tue, Oct 13, 2026, 9:00 AM ET". Its subject is "Cancelled: Your Nile Hands-On Lab reservation - <start>". This template is the body of the cancellation however it is sent: as the cancelled calendar invite (so the event is removed from the learner's calendar) or as the email. The learner should get one cancellation message, not two. The same email goes out when an admin cancels the booking or deactivating a learner cancels it.
- Authentik also protects the labs. Each testbed has its own Authentik group (amended 2026-10-22: the group is now predefined in Authentik, and the app no longer creates or removes it, see the last decision below). The group grants access to the URLs listed on that testbed (Nile Portal, LMS, and client URLs). When a learner books and is assigned a testbed, the app adds the learner to that testbed's group. How each URL is put behind Authentik and bound to the group is for `/architect` to settle.
- Lab access lasts only for the booking window: the learner is added to the testbed's group when the booking starts, and access is terminated right after the lab time is over (or at once on cancel or deactivation). Terminating means removing the group membership and ending any open sessions to the testbed's URLs, so a learner who is already in the lab is cut off too, not just blocked from signing in again.
- API keys (IDP and AI credentials) and the testbed's IDP field are built as in the mock, but nothing uses them yet: they are stored and edited only. Testbed access always goes through the testbed's Authentik group, whatever IDP the testbed names. The owner expects these keys may never be needed; hooking them into the labs is a Deferred roadmap item.
- Amended 2026-10-22 (inputs for `/architect`, features 19 and 20):
  - Each Nile tenant is tied to one email domain, so every testbed carries a mandatory Domain that the admin types. It must look like a valid domain name, for example `nileworkshop-1.com`, `nile.global`, or `rw.nile.global` (examples, not a fixed list). Among live testbeds, the name is unique and the domain is unique, each on its own, so one testbed per tenant domain.
  - Testbed groups are predefined in Authentik by a separate script (for example `NileWorkshop1Admin`). The testbed name must equal the group name exactly. The app creates and deletes no group: it refuses a testbed whose group does not exist, shows a hint under the Name field, and only adds and removes members. Cloudflare Access uses the same group name.
  - A learner's Authentik username is `firstname.lastname@domain`, at the domain of the assigned testbed; a random number is appended to the name part only when that address clashes with an existing user (a one word name becomes `firstname@domain`, with a number only on a clash). The email stays the real address, because the set password email needs it. The Nile attributes from `soleng2018/nile-idp` (`scripts/nile_idp.py`) are set, with `mail` set to the username. A learner keeps one Authentik user and one password; only the username follows the booked domain, and the app remembers each domain's login (spec 0019).
  - The learner sees their Nile login in the booked, rescheduled, and reminder emails, and on the booking success and reservation screens.
  - The booking rule does not change: a learner still holds at most one Upcoming or Current booking in total. The testbed, and so the domain, comes from availability, so a later booking can land in another domain. Only one of a learner's users is in a group at any moment.
  - Owner side work that goes with it: the `hol-labs-access` gate, the Cloudflare per VM rules, and each tenant's SAML NameID (to check, it should use the domain username).

## At a glance

| # | Feature | Phase | Status |
|---|---------|-------|--------|
| 1 | Stack & architecture | Foundation | done |
| 2 | Coding standards & tooling | Foundation | done |
| 3 | Data model | Foundation | done |
| 4 | Authentik sign in & provisioning | Foundation | done |
| 5 | Design system & UI foundation | Foundation | done |
| 6 | Core booking loop | Slice 1 | done |
| 7 | Admin: Testbed Types | Slice 2 | done |
| 8 | Admin: API Keys | Slice 2 | done |
| 9 | Admin: Testbeds | Slice 2 | done |
| 10 | Admin: Users & user detail | Slice 2 | done |
| 11 | Public landing page | Slice 3 | done |
| 12 | Availability & booking rules | Slice 3 | done |
| 13 | Manage reservations: sign in, cancel & reschedule | Slice 3 | done |
| 14 | Lab access & booking result screens | Slice 3 | done |
| 15 | Email delivery & booking confirmations | Slice 4 | done |
| 16 | Set password / welcome email | Slice 4 | done |
| 17 | Reminder before start | Slice 4 | done |
| 18 | Admin audit log | Slice 5 | done |
| 19 | Testbed domain & predefined groups | Slice 6 | done (amended 2026-10-26) |
| 20 | Nile identity per domain | Slice 6 | done |
| 21 | Testbed friendly name | Slice 6 | done |
| 22 | Cleanup gap between labs | Slice 6 | done |
| 23 | Cleanup hook for labs that end early | Slice 6 | done |
| 24 | Nile Portal reset when a lab ends | Slice 6 | planned |

## Foundations

### 1. Stack & architecture · done
Pick everything the Next.js base does not settle yet: persistence, hosting, how secrets are encrypted, email sending, and scheduled jobs. Then add only what slice 1 needs to the existing scaffold.
**Done when:** the stack is recorded in a spec, and the app boots locally and builds with its database connected.
- [x] Decide the stack (spec): `/architect stack & architecture`
- [x] Scaffold from the decision: `/develop stack & architecture`
spec [0001](../specs/0001-stack-architecture/index.md) · code in `./` (Next.js 16 App Router, TypeScript, Tailwind already scaffolded)

### 2. Coding standards & tooling · done
Record the project conventions and tooling choices from the real scaffold, then install lint, format, and pre commit checks.
**Done when:** root `AGENTS.md` reflects the real stack, and lint, format, and pre commit run clean.
- [x] Capture conventions + tooling choices: `/audit`

### 3. Data model · done
Core entities: testbed types, testbeds and their clients (each testbed linked to its Authentik group), API keys (with encrypted secrets), users linked to their Authentik identity, reservations, and audit events. Every later slice builds on these.
**Done when:** the schema supports the admin catalog, booking with no overlap per testbed and one active booking per learner, the delete blocking rules, and the audit log, with no breaking migration needed later.
- [x] Design it (spec): `/architect data model`
- [x] Build it: `/develop data model`
  - [x] Core migration with named constraints, version trigger, RLS, and codegen (AC-1, 2, 3, 5, 6, 9, 10, 12)
  - [x] Pure helpers: booking phase, duration, slug, enum parity (AC-5, 9, 11)
  - [x] Booking and delete data rules: constraint error mapping, locks, guarded updates, blockers (AC-1, 2, 3, 4, 12, 14)
  - [x] Guest saga data steps and compensation (AC-13)
- [x] Verify it: `/check verify data model` (AC-14 lock wait accepted on lock SQL evidence, engineer call 2026-10-06)
- [x] Test it: `/test data model`
spec [0002](../specs/0002-data-model/index.md) · code in `db/migrations/`, `server/db/`, `lib/`
(basis: data model is the costliest thing to redo)

### 4. Authentik sign in & provisioning · done · Full
Sign in through Authentik for two roles (admin, learner). Admin accounts already exist in Authentik and the app only recognizes them; it never creates admins. A server side Authentik API client that uses the master key only to set up the app's OIDC SSO configuration, and the provisioning key to create, update, and deactivate learners and to manage testbed groups and their members, including creating a learner at guest booking time and issuing the set password link that verifies their email.
**Done when:** an admin set up in Authentik signs in by opening the unlisted admin URL and choosing "Sign in with SSO" (no password is entered in the app), and a learner signs in through "Manage an existing reservation", each landing in their own area and blocked from the other's; no learner facing page links to the admin URL; the app has no path that creates an admin; a guest booking creates exactly one Authentik user (reusing an existing one for a known email); the set password link verifies the email; deactivating a user in the app blocks their sign in; admins and learners sign in through the same Authentik OIDC application; the provisioning key cannot create or change an admin, and runtime user calls never use the master key.
- [x] Design it (spec): `/architect authentik sign in & provisioning`
- [x] Build it: `/develop authentik sign in & provisioning`
  - [x] Spike 4 plus the idempotent `authentik:setup` script (AC-1, 11, 13)
  - [x] Better Auth migration, sign in hook, `require.ts`, admin tracer end to end (AC-1, 2, 7, 10, 11, 14, 16)
  - [x] Learner sign in page, error page, sign out, noindex (AC-2, 3, 12)
  - [x] Authentik client with guards, saga wiring, welcome job, resend (AC-4, 5, 6, 8, 9, 15, 16)
  - [x] Learner isolation and sign out return: sign out by API session delete, spike 2, setup script policy and `hol-authorization` flow, external learners, case insensitive email reuse, Playwright (AC-5, 12, 13, 17, 18)
- [x] Verify it: `/check verify authentik sign in & provisioning`
- [x] Test it: `/test authentik sign in & provisioning`
- [x] Review it (fresh model): `/check review authentik sign in & provisioning`
spec [0003](../specs/0003-authentik-sign-in-provisioning/index.md) · code in `server/auth/`, `server/authentik/`, `server/booking/guest-booking.ts`, `server/jobs/send-welcome.ts`, `app/reservations/`, `scripts/authentik-setup.ts`
(basis: auth is high risk and every slice depends on it, so it is a foundation at a higher tier)

### 5. Design system & UI foundation · done
Take the Nile visual language from the mock (colors, type, logo, rounded cards and pills) and turn it into design tokens and base components: the admin shell with sidebar and mobile nav, searchable table, form modal, delete confirm, the "in use" blocked dialog, and the toast.
**Done when:** `design.md` covers tokens and components, the base components handle keyboard and focus, and the admin shell matches the mock at desktop and mobile widths.
- [x] Design it (spec): `/architect design system & UI foundation`
- [x] Build it: `/develop design system & UI foundation`
  - [x] Tokens, Inter, logo and icons, with the contrast and style guard tests (AC-1, 2)
  - [x] Shell tracer on Testbed Types: nav plus Sheet, PageHeader, PageBody, DataTable, FormDialog, toast (AC-3, 4, 5, 6, 7, 9, 12, 14)
  - [x] Testbeds section, placeholders, delete flow, and the dev gallery (AC-5, 8, 9, 12, 13)
  - [x] Admin sign in card and learner frame (AC-10, 11, 14)
  - [x] Axe, keyboard and screenshot specs, and the root `design.md` (AC-14, 15, 16)
- [x] Verify it: `/check verify design system & UI foundation`
- [x] Test it: `/test design system & UI foundation`
spec [0005](../specs/0005-design-system-ui-foundation/index.md) · code in `app/globals.css`, `components/ui/`, `components/admin/`, `components/learner-frame.tsx`, `app/admin/`, `design.md`

## Slice 1: Core booking loop

### 6. Core booking loop · done
The walking skeleton, real at every layer and as narrow as possible. An admin signs in and creates one testbed type and one testbed. A guest fills the mock's Step 1 form, picks a start time from a plain list, and confirms; the app creates their Authentik user and the booking together, and adds the user to the testbed's Authentik group. No calendar, landing page, emails, search, editing, or cancel yet.
**Done when:** that full path works against the real database and real Authentik; a failed step leaves nothing booked, no orphan user, and no stray group membership; a second guest cannot book the same testbed for an overlapping time.
- [x] Design it (spec): `/architect core booking loop`
- [x] Build it: `/develop core booking loop`
  - [x] Admin tracer: shadcn init, pod group create, create only type and testbed forms with the row first group saga (AC-1, 2, 13)
  - [x] Guest tracer: slot math, saga step 1 rework with assignment and rollback, `/book` form and confirmation (AC-3, 5, 6, 7, 8, 9, 13)
  - [x] Abuse guard and failure paths: rate limits, trusted IP, Turnstile, race and timeout tests (AC-2, 3, 4, 9, 10) (AC-10 race: in order assignment test plus the manual two browser check in verify.md accepted instead of a two connection DB test, which would have to commit to the shared database, engineer call 2026-10-08)
  - [x] Worker: lock, sequential loop, sweepers, and the access reconciler (AC-11, 12)
  - [x] Playwright happy path (AC-1, 2, 3, 5, 6)
- [x] Verify it: `/check verify core booking loop` (29 of 30 steps; the prod rate limit step through the Cloudflare Tunnel is owed to the spec 0001 image and compose work, engineer call 2026-10-09)
- [x] Test it: `/test core booking loop`
spec [0004](../specs/0004-core-booking-loop/index.md) · code in `app/book/`, `app/admin/`, `server/booking/`, `server/catalog/`, `server/worker/`, `worker/`, `lib/`
(basis: vertical slices prove the layers connect before breadth is added)

## Slice 2: Admin console (from the mock)

### 7. Admin: Testbed Types · done
List, search, add, edit, and delete testbed types (name plus a duration in hours or days), with a count of the testbeds that use each type.
**Done when:** the screen matches the mock; duration must be at least 1; deleting a type still used by testbeds is blocked and the dialog lists those testbeds.
- [x] Build it: `/develop admin: testbed types`
code in `app/admin/testbed-types/`, `app/admin/actions.ts`, `server/catalog/testbed-types.ts`, `components/admin/testbed-type-fields.tsx` (rules from specs [0002](../specs/0002-data-model/index.md) AC-4, AC-5, AC-14 and [0005](../specs/0005-design-system-ui-foundation/index.md) delete flow)

### 8. Admin: API Keys · done · Full
List, search, add, edit, and delete IDP and AI credentials (name, type, base URL, secret). Secrets are entered once and are write-only afterward: the list shows only a fixed mask, and there is no reveal or copy. Editing a key leaves the secret unchanged unless the admin types a replacement. Keys are stored only; no part of the app calls them yet (see Deferred).
**Done when:** secrets are encrypted at rest and never sent back to the browser after they are saved; there are no reveal or copy controls (as in the mock); replacing a secret works from the edit dialog; deleting a key assigned to a testbed is blocked and the dialog lists those testbeds.
- [x] Design it (spec): `/architect admin: api keys`
- [x] Build it: `/develop admin: api keys`
  - [x] Encryption core: AES-256-GCM with row binding, lazy keyring env, `secrets:keygen` (AC-7, 9)
  - [x] Tracer: migration, add and list with the mask and changed date, not configured state (AC-1, 2, 3, 7, 9, 10, 11)
  - [x] Edit: keep or replace the secret, audit rows, type change block (AC-3, 4, 5)
  - [x] Delete with testbed blockers, plus the leak proof (canary Playwright, query and source scans) (AC-1, 4, 6, 8, 10)
- [x] Verify it: `/check verify admin: api keys`
- [x] Test it: `/test admin: api keys`
- [x] Review it (fresh model): `/check review admin: api keys`
- [x] Document it: `/document admin: api keys`
spec [0006](../specs/0006-admin-api-keys/index.md) · code in `app/admin/api-keys/`, `app/admin/actions.ts`, `server/catalog/api-keys.ts`, `server/crypto/`, `server/env.ts`, `components/admin/api-key-fields.tsx`, `lib/api-keys.ts`, `lib/changed-fields.ts`, `db/migrations/0005_api_keys.sql`, `scripts/secrets-keygen.ts`

### 9. Admin: Testbeds · done
List, search, add, edit, and delete testbeds: name, type, IDP (chosen from IDP API keys, stored only and not used for access yet), Nile Portal URL, LMS URL, and a list of wired or wireless clients, each with a name and URL.
Saving a new testbed creates its Authentik group and protects its URLs with it; editing the URLs updates that protection; deleting the testbed removes the group.
Replaced in part by feature 19 (2026-10-22): the app no longer creates or removes the group, it uses one that already exists.
**Done when:** the screen and form match the mock, including adding and removing client rows; a new testbed has its own Authentik group and its URLs are reachable only by members of that group; a failed Authentik step leaves no half created testbed; deleting a testbed with Upcoming or Current bookings is blocked and the dialog lists them.
- [x] Design it (spec): `/architect admin: testbeds`
- [x] Build it: `/develop admin: testbeds`
  - [x] Migration plus the add strand: IDP picker, client OS credentials, mock list columns with the not ready badge and search (AC-1, 2, 8)
  - [x] Edit: load on open, update with locks and audit, not ready guard (AC-3, 4, 5, 9)
  - [x] Delete with phase labelled reservation blockers (AC-6, 9)
  - [x] Worker teardown of a deleted testbed's group, reconciler skip (AC-7)
  - [x] Guards and end to end: `os_password` source scan, auth tests, Playwright happy path (AC-1, 2, 3, 6, 9, 10)
- [x] Verify it: `/check verify admin: testbeds`
- [x] Test it: `/test admin: testbeds`
- [x] Review it (fresh model): `/check review admin: testbeds`
spec [0007](../specs/0007-admin-testbeds/index.md) · code in `app/admin/testbeds/`, `app/admin/actions.ts`, `server/catalog/testbeds.ts`, `server/worker/teardown.ts`, `server/db/delete-blockers.ts`, `components/admin/testbed-fields.tsx`, `components/admin/testbed-edit-dialog.tsx`, `lib/testbeds.ts`, `lib/catalog-input.ts`, `db/migrations/0006_testbed_admin.sql`

### 10. Admin: Users & user detail · done · Full
List and search learners (name, company, email, booking count, status); admin accounts live only in Authentik and are not managed here. Add and edit learners, deactivate and reactivate them, and open a detail page with their bookings and statuses. Add, edit, and deactivate are synced to Authentik. The mock's generated password is dropped because Authentik owns credentials. Admins can cancel a booking from the detail page.
**Done when:** a user added here can sign in through Authentik; deactivating one blocks their sign in, frees their future bookings, and removes them from testbed groups, per the spec; the detail page shows Upcoming, Current, and Past bookings in the admin's timezone.
- [x] Design it (spec): `/architect admin: users & user detail`
- [x] Build it: `/develop admin: users & user detail`
  - [x] Read thread: index migration, admin timezone from the browser, Users list and read only detail page (AC-1, 2, 3, 15)
  - [x] Add strand: learner input, add saga with never logged in reuse, add dialog with timezone, unlinked learner sweeper (AC-4, 5, 12, 13)
  - [x] Edit strand: lock first edit with Authentik name and email sync, email lock, resend button (AC-6, 7, 13)
  - [x] Status and cancel strand: deactivate with booking cancels and confirm list, reactivate, reconciler status filter, admin cancel (AC-8, 9, 10, 11, 13)
  - [x] Guards and end to end: auth tests for every action, Playwright happy path (AC-1, 2, 4, 6, 8, 9, 14)
- [x] Verify it: `/check verify admin: users & user detail`
- [x] Test it: `/test admin: users & user detail`
- [x] Review it (fresh model): `/check review admin: users & user detail`
- [x] Document it: `/document admin: users & user detail`
spec [0008](../specs/0008-admin-users/index.md) · code in `app/admin/users/`, `server/users/`, `server/authentik/learners.ts`, `server/db/refusal.ts`, `server/worker/sweep.ts`, `server/worker/reconcile.ts`, `components/admin/learner-fields.tsx`, `components/admin/learner-status-actions.tsx`, `components/admin/booking-cancel-button.tsx`, `components/admin/admin-timezone-sync.tsx`, `lib/learners.ts`, `lib/learner-input.ts`, `db/migrations/0007_admin_users.sql`

## Slice 3: Learner portal (from the mock)

### 11. Public landing page · done
The learner home from the mock: hero, "Reserve a lab" and "Manage an existing reservation" actions, and the three step explainer.
**Done when:** the page matches the learner mock, renders without sign in, and has its title, description, and social card metadata; it shows no admin sign in or sign up link.
- [x] Design it (spec): `/architect public landing page`
- [x] Build it: `/develop public landing page`
  - [x] Landing tracer: hero and social assets, `appUrl()`, frame without Sign out, the page with its metadata, Playwright landing spec (AC-1, 2, 3, 4, 6, 9)
  - [x] Indexing: root `noindex` default, `robots.txt` and sitemap, build and unreachable database checks (AC-1, 7, 8, 9)
  - [x] Nile footer on every learner page, with contrast pairs (AC-5)
  - [x] Axe and screenshots for `/`, `/book` captured again (AC-5, 10)
- [x] Verify it: `/check verify public landing page`
- [x] Test it: `/test public landing page`
- [x] Review it (fresh model): `/check review public landing page`
spec [0009](../specs/0009-public-landing-page/index.md) · code in `app/page.tsx`, `app/robots.ts`, `app/sitemap.ts`, `app/layout.tsx`, `components/learner-frame.tsx`, `components/learner-footer.tsx`, `server/env.ts` (`appUrl()`), `public/brand/hol-hero.jpg`, `public/brand/hol-social.jpg`, `e2e/landing.spec.ts`

### 12. Availability & booking rules · done
Thicken slice 1's booking into the mock's full 3 step flow: details form with timezone choice, month calendar with unavailable days greyed, 30 minute start slots for the chosen day with the full duration highlighted, the confirm step showing the assigned testbed, and the progress and failure screens.
**Done when:** a learner sees only bookable days and times in their timezone; two learners booking the last free slot at once cannot both get it; an email that already has an active booking is stopped at Step 1 with a link to manage it.
- [x] Design it (spec): `/architect availability & booking rules`
- [x] Build it: `/develop availability & booking rules`
  - [x] Tracer: calendar and timezone helpers, the 90 day horizon, then the three step shell with the real calendar and submit on today's actions (AC-1, 4, 5, 11)
  - [x] Step 1 check with its fail open buckets, and the timezone combobox (AC-1, 2, 3, 13)
  - [x] Step 3 preview with explicit Turnstile, then progress, failure, and result routing (AC-7, 8, 9, 11, 12, 13)
  - [x] Success card and calendar freshness (AC-6, 10)
  - [x] Guards and end to end: Playwright flows, axe, keyboard, screenshots (AC-3, 9, 11, 12, 13, 14)
- [x] Verify it: `/check verify availability & booking rules`
- [x] Test it: `/test availability & booking rules`
spec [0010](../specs/0010-availability-booking-rules/index.md) · code in `app/book/`, `components/book/`, `lib/booking-flow.ts`, `lib/calendar-days.ts`, `lib/timezones.ts`, `server/booking/availability.ts`, `server/booking/details-check.ts`, `components/turnstile.tsx`, `components/timezone-combobox.tsx`, `components/ui/calendar.tsx`, `e2e/booking.spec.ts`, `e2e/book-flow.ts`

### 13. Manage reservations: sign in, cancel & reschedule · done
"Manage an existing reservation" from the mock: sign in through Authentik, see all bookings with status, reserve another when none is active, and cancel or reschedule Upcoming and Current bookings through the same calendar.
**Done when:** cancel frees the testbed at once (ending a Current booking early); reschedule either succeeds atomically or leaves the original untouched; Past bookings cannot be changed; a deactivated user cannot sign in.
- [x] Design it (spec): `/architect manage reservations`
- [x] Build it: `/develop manage reservations`
  - [x] List tracer: learner bookings read, cards, Reserve another rule (AC-1, 2, 3, 15)
  - [x] Cancel: locked learner cancel with audit, confirm dialog, toasts (AC-4, 5, 15, 17)
  - [x] Reschedule end to end: excluded own range, kept testbed, locked in place update, reschedule page and actions, bare flow (AC-6, 7, 9, 11, 15, 17)
  - [x] Reschedule polish: preview, Current slot, progress and failure routing, history, per user buckets (AC-7, 8, 10, 12, 14)
  - [x] Signed in `/book`, then guards and end to end: account summary, session override, `signed_out`, reconciler, Playwright journey, axe, screenshots (AC-3, 13, 15, 16, 18)
- [x] Verify it: `/check verify manage reservations`
- [x] Test it: `/test manage reservations`
- [x] Review it (fresh model): `/check review manage reservations`
spec [0011](../specs/0011-manage-reservations/index.md) · code in `app/reservations/`, `components/reservations/`, `server/booking/manage.ts`, `server/booking/account.ts`, `lib/manage-reservations.ts`, `lib/reschedule-flow.ts`, `lib/time-pick.ts`, `app/book/`, `components/book/`, `e2e/reservations.spec.ts`

### 14. Lab access & booking result screens · done
The success screen after booking or rescheduling, and the reservation detail page, both showing the testbed's Nile Portal, LMS course, and client links as in the mock.
Access is enforced by Authentik: the learner is in the assigned testbed's group for the booking, and is removed right after the lab time ends.
**Done when:** access details reach only the booking's own verified learner; a learner can open the testbed's URLs only during their booking window, and an open lab session stops working right after the lab time is over; cancel, reschedule to another testbed, and booking end update the group membership; Upcoming bookings show no detail link, Current and Past do; Past details show the links greyed out and unclickable with the "access is no longer active" note; the success screen tells a new learner to set their password from the email.
- [x] Design it (spec): `/architect lab access & booking result screens`
- [x] Build it: `/develop lab access & booking result screens`
  - [x] Spike 3 with the owner: Cloudflare Access revoke ends an open browser VM session; surfaced the HOL Labs app and the API key move (AC-9, 10)
  - [x] Tracer: `ownLabAccess`, the lab access card, the `/reservations/[id]` detail page, and View lab access on Current and Past cards (AC-1, 6, 7, 8)
  - [x] Success screens: lab access card on book and reschedule success, guest and new learner copy (AC-2, 3, 4, 5)
  - [x] Cloudflare key and revoke strand: the `CLOUDFLARE` API key (migration, Access probe on save), the revoker reading it per run, reconciler order and audit outcome (AC-9, 10, 11, 12)
  - [x] HOL Labs in the setup script and its isolation checks: `authentik:setup` adopts the app, provider, flow, and policy (spec 0003 AC-19) (AC-9)
  - [x] Guards and end to end: detail page auth, Playwright journey, axe, screenshots, `verify.md` (AC-2, 3, 7, 8, 9, 10, 12)
  - [x] VM cut correction (spec 0012 task 9): the revoke blocks new requests only, so add the "close your lab tabs" copy (Current note, `cancelAccessLine` for the learner and admin cancel dialogs) and fix the revoke comments (AC-7, 10, 13, 14)
- [x] Verify it: `/check verify lab access & booking result screens`
- [x] Test it: `/test lab access & booking result screens`
spec [0012](../specs/0012-lab-access-result-screens/index.md) · code in `app/reservations/[id]/`, `components/reservations/lab-access-card.tsx`, `components/reservations/cancel-reservation-button.tsx`, `components/admin/booking-cancel-button.tsx`, `server/booking/lab-access.ts`, `lib/lab-access.ts`, `lib/manage-reservations.ts`, `server/cloudflare/`, `server/catalog/api-keys.ts`, `server/worker/`, `worker/index.ts`, `db/migrations/0008_cloudflare_api_key.sql`, `scripts/authentik-setup.ts`, `app/book/`, `components/book/`, `e2e/lab-access.spec.ts`, `e2e/hol-labs.spec.ts`

## Slice 4: Notifications

### 15. Email delivery & booking confirmations · done
Set up email sending and shared templates (the umbrella that features 16 and 17 build on), then send a confirmation with a calendar invite on book, reschedule, and cancel, with times in the learner's timezone. Book, reschedule, and cancel use the mock's email templates.
**Done when:** book, reschedule, and cancel emails match the mock's templates and subjects, and render correctly in common mail clients; each of those three actions sends one correct email whose invite adds, moves, or removes the calendar event; a failed send never undoes the booking change.
- [x] Design it (spec): `/architect email delivery & booking confirmations`
- [x] Build it: `/develop email delivery & booking confirmations`
  - [x] Foundations and tracer: worker render hook, migration `0009`, the `GOOGLE` service account key on create with its save check, the job runner, and one booked email end to end (AC-1, 2, 3, 5, 6, 7, 8, 11, 12, 14, 15, 16, 17, 22, 24)
  - [x] Reschedule, cancel, and failure strands: the other two emails, version order, no key wait, breaker, stale skip (AC-6, 8, 9, 10, 13, 17, 18)
  - [x] Calendar mirror and backfill (AC-19, 20)
  - [x] Key edit and the console Emails section (AC-4, 21)
  - [x] Proof: snapshots, leak scans, Playwright, and the mail client matrix in `verify.md` (AC-5, 23)
  - [x] Google sign in, for a personal Gmail sender (spec amended 2026-10-16): migration `0010`, the method radio, sign in with paste back, the refresh token mint, and one email to the dev inbox (AC-25, 26, 27, 28, 30, 34)
  - [x] Google sign in thickened: edit and switch methods, the breaker by method with the Needs attention badge, and its proof (AC-29, 31, 32, 33)
  - [x] Exchange outage keeps the sign in, so the same save can be retried (spec amended 2026-10-16, task 13) (AC-28)
  - [x] Review fixes: the invite attached once outside `multipart/alternative` with a MIME tree test, the booked email in the zone `/book` showed, the rescheduled intro and the password box for new accounts only (spec amended 2026-10-16, task 14) (AC-6, 11, 12, 15, 17, 23)
  - [x] One zone per booking and the UTC label: later emails reuse the booked email's zone through `bookingZone`, and emails print `UTC` instead of `GMT+0` (spec amended 2026-10-17, task 15) (AC-6, 11, 14)
  - [x] The sender's own mailbox and Gmail's copy: a Dev inbox or Ops BCC in the sender's mailbox refused at save and dropped at send, and AC-15 restated for what Gmail delivers (spec amended 2026-10-17, task 16) (AC-15, 16, 17, 35, 36)
- [x] Verify it: `/check verify email delivery & booking confirmations` (2026-10-18; the four live service account steps accepted on test coverage until a Workspace account exists, and the matrix on iOS Mail and Gmail web only, both by the owner)
- [x] Test it: `/test email delivery & booking confirmations`
spec [0013](../specs/0013-email-delivery-booking-confirmations/index.md) · code in `server/jobs/`, `server/email/`, `server/google/`, `server/catalog/api-keys.ts`, `lib/booking-email.ts`, `lib/email-routing.ts`, `worker/`, `db/migrations/0009_google_email.sql`, `db/migrations/0010_google_sign_in.sql`, `lib/google-sign-in.ts`, `components/admin/api-key-fields.tsx`, `scripts/calendar-backfill.ts`

### 16. Set password / welcome email · done
The email a new user gets when their account is created, at guest booking or by an admin, carrying the set password link that also verifies their email.
**Done when:** each new user gets exactly one such email; the link expires, works once, and lands them signed in.
- [x] Design it (spec): `/architect set password / welcome email`
- [x] Build it: `/develop set password email`
  - [x] Authentik spike on dev: `next` on a token flow, token reuse, single use, origins; pick the main or fallback landing (AC-11, 12) (main path: Authentik keeps `next`)
  - [x] Tracer: migration `0011`, the welcome template, the handler, the `hol-recovery-login` stage, and one email clicked through to signed in (AC-1, 4, 7, 8, 9, 10, 11, 15)
  - [x] Failure strands: Dead, Already set, unavailable, the miss limit, Gmail outcomes, stale jobs, no BCC (AC-2, 5, 6, 9, 10, 12)
  - [x] One send and revocation: the covered check, `other_used`, email change ends links, purge, smoke render (AC-3, 13, 14, 16, 17)
  - [x] Proof: snapshots, leak scans, allow list, Playwright, and `verify.md` (AC-5, 7, 11, 12, 18, 19)
  - [x] Timed out view: `onAPIError.errorURL`, the "Sign in timed out" view with a Sign in button on `/auth/error` (AC-19)
- [x] Verify it: `/check verify set password / welcome email`
- [x] Test it: `/test set password / welcome email`
spec [0014](../specs/0014-set-password-welcome-email/index.md) · code in `server/jobs/send-welcome.ts`, `server/jobs/welcome-queue.ts`, `server/auth/set-password-links.ts`, `server/auth/start-set-password.ts`, `server/email/templates/welcome-email.tsx`, `app/set-password/`, `components/auth/`, `lib/welcome-email.ts`, `lib/set-password-link.ts`, `db/migrations/0011_set_password_links.sql`, `scripts/authentik-setup.ts`, `lib/auth-errors.ts`, `app/auth/error/`, `server/auth/index.ts`

### 17. Reminder before start · done
A scheduled reminder email shortly before a booking starts.
**Done when:** each booking that is still active gets one reminder at the set lead time; a cancelled or rescheduled booking never gets a stale reminder.
- [x] Design it (spec): `/architect reminder before start`
- [x] Build it: `/develop reminder before start`
  - [x] Tracer: `REMINDER_LEAD_MS`, the `reminder` kind and subject, the "reminders" sweep and `queueReminder`, the worker step, and one real reminder sent on dev (AC-1, 2, 3, 4, 5, 6) · all built and tested; the real dev send was made by `/check verify` (2026-10-20)
  - [x] Send time checks: changed booking and 1 hour floor suppress, no Bcc, catch up (AC-8, 9, 11, 12)
  - [x] Claim order: the new `claimJob` clause, so reminders block nothing and wait for their own confirmation (AC-10)
  - [x] The real email: `LabAccessEmail` reminder branch, the invite, the start up render check and samples (AC-7)
  - [x] Proof: DB tests for the due rules, suppress paths and claim order, snapshots, a console regression check, and `verify.md` (AC-13, 14)
- [x] Verify it: `/check verify reminder before start`
- [x] Test it: `/test reminder before start`
spec [0015](../specs/0015-reminder-before-start/index.md) · code in `server/jobs/reminders.ts`, `server/jobs/booking-notice.ts`, `server/jobs/send-email.ts`, `server/jobs/runner.ts`, `server/email/templates/lab-access-email.tsx`, `lib/booking-email.ts`, `lib/slots.ts`, `worker/index.ts`

## Slice 5: Accountability

### 18. Admin audit log · done
Record who did what: API key secret creation and replacement, catalog changes, testbed group changes in Authentik, user deactivation, and booking cancellations by admins. Admins can view the log.
**Done when:** each of those actions writes an entry with actor, action, target, and time; entries cannot be edited from the app.
- [x] Design it (spec): `/architect admin audit log`
- [x] Build it: `/develop admin audit log`
  - [x] Tracer: migration `0012` keyset index, labels and actor kinds in `lib/audit-log.ts`, the Audit Log nav section and first page of rows (AC-1, 2, 6, 7, 13, 15)
  - [x] Paging and filters: keyset Older and Newer, the URL filter form, the dropped filter notice, empty states (AC-3, 4, 14)
  - [x] Row detail: `describeMetadata` and the expand disclosure (AC-8)
  - [x] History strand: `target` and `learner` filters with chips, History links on the four lists, the user detail History section (AC-5, 9, 10)
  - [x] Guards and proof: coverage test, append only source scan, Playwright, axe, screenshots, `verify.md` (AC-11, 12, 16)
- [x] Verify it: `/check verify admin audit log` (2026-10-20; the timezone change, rename, and screenshot steps left to `/test`, since they write to the database or the committed shots)
- [x] Test it: `/test admin audit log` (2026-10-20; the existing suite, 113 Vitest and 5 Playwright, all pass)
spec [0016](../specs/0016-admin-audit-log/index.md) · code in `lib/audit-log.ts`, `server/audit-log.ts`, `app/admin/audit-log/`

## Slice 6: Nile tenants

### 19. Testbed domain & predefined groups · done · Full
Every testbed gets a mandatory Domain, one per Nile tenant. The app stops creating and deleting testbed groups: an admin names the testbed exactly like a group that already exists in Authentik (for example `NileWorkshop1Admin`, made by a separate script), and the app refuses the testbed when no such group exists. A small hint under the Name field says the name must be the group name. Cloudflare Access per VM rules use the same group name. This replaces the app made `pod-<slug>` groups of features 6, 9, and 14.
**Done when:** an admin cannot save a testbed without a Domain, or with one that is not a valid domain name; a second live testbed with the same name, or the same domain (ignoring case), is refused with a clear message and nothing is written; a name that matches no Authentik group is refused with a clear message and nothing is written; the app creates and deletes no group in Authentik; a booked learner is added to the group named like the testbed and removed from it when the booking ends; deleting a testbed leaves its group alone; the HOL Labs gate no longer depends on `pod-` names.
- [x] Design it (spec): `/architect testbed domain & predefined groups`
- [x] Build it: `/develop testbed domain & predefined groups` (owner steps first: mark the groups, delete the live testbeds; see the spec's migration plan)
  - [x] Foundation and guard: migration `0013`, domain input, constraint mappings, audit actions, the marker guard and group lookup (AC-1, 2, 3, 4, 7, 10, 11)
  - [x] Create thread: lookup then insert, Domain field and Name hint, list column, the old group machinery removed (AC-1, 2, 3, 5, 7, 8)
  - [x] Edit thread: name locked, domain edit with the booking lock (AC-5, 6, 7)
  - [x] Delete and reconcile: the release step, the reconciler per group pk with stale check and relink by name (AC-9, 10)
  - [x] Gate and proof: the marker based HOL Labs gate, the group writes source scan, Playwright on marked throwaway groups (AC-4, 12, 13)
- [x] Verify it: `/check verify testbed domain & predefined groups`
- [x] Test it: `/test testbed domain & predefined groups`
- [x] Review it (fresh model): `/check review testbed domain & predefined groups`
- [x] Document it: `/document testbed domain & predefined groups` (changelog entry in `CHANGELOG.md`, 2026-10-26)
spec [0017](../specs/0017-testbed-domain-predefined-groups/index.md)

> Amendment (2026-10-26): pick the group, don't type it. Inputs for `/architect`, who amends spec 0017.
> - Today the admin types the group name exactly. Instead, the add form shows a dropdown of the Authentik groups that carry the `hol_testbed_group: true` attribute (the marker the app already checks). This is a convenience only: saving still runs the same lookup and marker check, so a stale or tampered choice is refused as before.
> - Confirmed possible (live read, 2026-10-26): Authentik lists groups filtered by that attribute with the provisioning token the app already holds, and returns exactly the 15 marked groups today (NileWorkshop1 to 5, each as Admin, Contractor, and Employee). No new permission is needed, and the app still never writes a group.
> - The dropdown hides groups that a live testbed already uses (one live testbed per group), and shows a clear message with the choice disabled when Authentik cannot be reached.
> - The domain cannot be pulled today. The marked groups carry only the marker, and the provisioning token is refused (403) on the SAML provider list, so the app has no reliable source for it. Recommended path for the owner: add a domain attribute (suggested name `hol_testbed_domain`) to each marked group, through the `nile-idp` script or by hand. Then the form fills Domain from the chosen group. The admin can still edit it, and it still passes the domain format check and the unique domain rule. Where a group has no such attribute, Domain stays a typed field, so nothing blocks on the owner. Guessing the domain from the `NileWorkshopN` name is not recommended, because it breaks the first time a name changes.
> - Unchanged: feature 21's split between Group Name (admin side) and Name (what learners see); the name lock on edit; the domain lock while a booking is Upcoming or Current.
> - Open for `/architect`: the attribute name and where its value is validated, how a group with a bad or missing domain attribute behaves, whether the Contractor and Employee groups should appear in the list or only Admin groups, and whether the list is read when the dialog opens or cached for a short time.

**Amendment done when:** the add form offers a dropdown of marked groups and no free text group field; a group already used by a live testbed is not offered; an unreachable Authentik shows a clear message and blocks saving; saving a group that is no longer marked, or was removed after the list loaded, is refused with the existing message and nothing is written; when the chosen group carries a domain attribute, Domain is filled from it and stays editable, and when it does not, Domain is typed as today; the app still creates, updates, and deletes no group.
- [x] Design it (spec): `/architect testbed group dropdown and domain prefill` (amends spec 0017, AC-14 to AC-19; decided 2026-10-26: the list offers marked groups whose name ends in `Admin`, read on dialog open with no cache, domain attribute `hol_testbed_domain` parsed by the domain rules, a bad or missing value just leaves Domain typed) Revised 2026-10-27: the `Admin` name rule is dropped, the marker alone decides.
- [x] Build it: `/develop testbed group dropdown and domain prefill` (owner step first, optional: add the domain attribute to the marked groups) code in `server/authentik/groups.ts`, `components/admin/testbed-add-dialog.tsx`, `e2e/testbed-group-dropdown.spec.ts` (Playwright passed 2026-10-27)
  - [x] Group choices read: the filtered, paged Authentik list, the unique name rule, the domain attribute parse, hide used groups, fake Authentik filter (AC-15, 16, 17, 19)
  - [x] Add dialog: `loadTestbedGroupChoices`, the client add dialog with loading, unavailable, and empty states, the select and domain fill, hints, Playwright (AC-13, 14, 17, 18, 19)
  - [x] Domain from the group (spec 0017 task 10): `parseGroupDomain`, `TestbedGroup.domain`, create reads the domain from the group (`group_no_domain`), no `domain` in the inputs or the edit, no domain lock, the read only Domain box and disabled no domain options, tests (AC-1, 2, 20 to 23); Playwright updated but not run, the hol-test fixtures are gone
- [x] Verify it: `/check verify testbed group dropdown and domain prefill` (2026-10-26, live: dropdown, read only Domain, no valid domain refusal, none has a domain message, Authentik unreachable alert; the steps that add or delete a real testbed were left to the unit and DB tests)
- [x] Test it: `/test testbed group dropdown and domain prefill` (vitest 481 pass, Playwright `testbed-group-dropdown` and `testbeds` pass)

> Ownership (2026-10-25): the `soleng2018/nile-idp` script owns the Authentik SAML and SCIM setup for Nile tenants and the shared `Nile:` mappings; the owner does the Nile Portal checklist by hand; this app owns the learner user, its domain username and `attributes.mail`. Table in [spec 0019](../specs/0019-nile-identity-per-domain.md).

### 20. Nile identity per domain · done · Full
When a learner is booked on a testbed, their Authentik user gets a username in that testbed's domain, so they can sign in to that Nile tenant. It stays one Authentik user per learner, with one password. The username is `firstname.lastname@domain` (lowercased); a random number is appended to the name part only when that address clashes with an existing user (`firstname.lastname4821@domain`). If only a first name is given, it is `firstname@domain`, with a number only on a clash. The email field stays the learner's real address, because the set password email needs it. The Nile attributes from the `nile-idp` script are set (`mail` set to the username, plus `firstName` and `lastName`; `mobile` is left unset). A small table remembers each learner's login per domain, so booking in a domain again gives the same login. When a booking or reschedule lands on another domain, only the username and `mail` change. The learner sees their Nile login in the booked, rescheduled, and reminder emails, and on the booking success and reservation screens. Builds on feature 19.
**Done when:** a new booking sets the learner's Authentik username, `mail`, `firstName`, and `lastName` for the testbed's domain and leaves the real email alone; the same domain again changes nothing; another domain changes only the username and `mail`; a clash adds a random number, and none adds none; a failed Authentik step refuses the booking with nothing saved; the login reaches only the booking's own learner, in emails and on screens; the reconciler, sign in, and deactivation keep working on the same user.
- [x] Design it (spec): `/architect nile identity per domain`
- [x] Build it: `/develop nile identity per domain` (owner checks first: Authentik accepts the real email at sign in, and each tenant's SAML NameID uses the username; see the spec's Follow-up)
  - [x] Login rules and storage: `lib/nile-login.ts`, migration `0015`, audit actions (AC-1, 2, 3, 10, 11)
  - [x] Thin thread: `ensureNileLogin` in the guest saga, stored pk lookup, the booked email shows the login (AC-3, 4, 5, 6, 9, 12)
  - [x] Reschedule onto another domain, with rollback and rename back (AC-4, 5)
  - [x] Remaining surfaces: reminder and rescheduled emails, success screens, lab access card, admin Nile logins list, admin email fix (AC-6, 7, 8)
  - [x] Proof: reconciler and deactivation unchanged, source scan, tests (AC-9, 12)
- [x] Verify it: `/check verify nile identity per domain` (2026-10-25, live dev run; AC-5 outage, AC-12 admin refusal and the reminder email rest on unit tests)
- [x] Test it: `/test nile identity per domain` (2026-10-25: send time login in booked, rescheduled, cancelled and reminder emails; reschedule conflict and untagged refusals; numbered login and admin email refusal in the guest saga (the `ensureNileLogin` guard, AC-12, is covered by the guard tests))
- [x] Review it (fresh model): `/check review nile identity per domain`
- [ ] Document it: `/document nile identity per domain`
spec [0019](../specs/0019-nile-identity-per-domain.md)
code in `lib/nile-login.ts`, `server/authentik/nile-login.ts`, `server/booking/`, `db/migrations/0015_learner_domain_logins.sql`

### 21. Testbed friendly name · done
Builds on feature 19. Today a testbed's Name is the Authentik group name, so learners see something like `NileWorkshop1Admin` in invites and emails. Rename that field to Group Name (still must match a marked Authentik group, still unique among live testbeds). Add a new Name field, free text the admin chooses, which is what learners see in the booked, rescheduled, cancelled, and reminder emails, the calendar invite, and the booking and reservation screens. The group name stays on the admin side only.
**Done when:** the testbed form shows Group Name (with the group hint) and a new Name; a testbed cannot be saved without a Name; existing testbeds start with their current name copied into both fields so nothing changes until an admin edits it; every learner facing place shows Name and never the group name; admin lists and the audit log show both; Cloudflare and Authentik behavior is unchanged.
- [x] Design it (spec): `/architect testbed friendly name`
- [x] Build it: `/develop testbed friendly name` (owner steps first: the one deploy carries migrations 0013 and 0014; see the spec's migration plan)
  - [x] Migration and thin thread: `0014`, codegen, constraint mapping, the add form with both fields, the booked email showing only the Name (AC-1, 2, 3, 5, 7)
  - [x] Create and edit rules: duplicate order, Group Name errors, editable Name with the read only Group Name (AC-2, 3, 4)
  - [x] Group facing code and admin views: reconciler, audit log, list columns and search (AC-7, 8)
  - [x] Learner surface scan, rename behavior, auth and tests (AC-5, 6, 9)
- [x] Verify it: `/check verify testbed friendly name`
- [x] Test it: `/test testbed friendly name`
- [x] Review it (fresh model): `/check review testbed friendly name`
spec [0018](../specs/0018-testbed-friendly-name.md) · code in `server/catalog/testbeds.ts`, `db/migrations/0014_testbed_group_name.sql`

### 22. Cleanup gap between labs · done
Builds on the booking rule in feature 12. Cleanup automation needs time on a testbed between two labs, so a testbed is held for a set gap (30 minutes) after each booking ends. A lab booked 8 am to 12 pm means the next lab on that testbed cannot start before 12:30 pm. Today two bookings only have to not overlap, so a next lab can start at the exact minute the last one ends.
**Done when:** the start time picker never offers a start inside the gap, for new bookings and for reschedules; the server and the database both refuse a booking that would start inside the gap, with the same "time no longer available" reply as an overlap; a booking never blocks itself when it is rescheduled; cancelling a booking frees its gap too; bookings already in the system keep working; learner screens and emails that show times are unchanged.
- [x] Design it (spec): `/architect cleanup gap between labs`
- [x] Build it: `/develop cleanup gap between labs` (the one deploy carries migration 0016; run the read only pre-check first, see the spec's migration plan)
  - [x] Migration 0016 and the database rule, proved on a throwaway copy (AC-1, 7, 8)
  - [x] Picker and server recheck: `GAP_MS`, `freeStarts`, `busyRanges`, and the lead time check (AC-2, 3, 6, 10)
  - [x] Reschedule clash query, cancel and complete behavior (AC-4, 5)
  - [x] Existing test fixes, new scenarios, and the learner and admin copy scan (AC-9, and the tests for all)
- [x] Verify it: `/check verify cleanup gap between labs`
- [x] Test it: `/test cleanup gap between labs`
spec [0020](../specs/0020-cleanup-gap-between-labs/index.md) · code in `lib/slots.ts`, `server/booking/availability.ts`, `server/booking/manage.ts`, `db/migrations/0016_booking_cleanup_gap.sql`

### 23. Cleanup hook for labs that end early · done
Follow up from spec 0020. A Current booking that is cancelled (by anyone) or moved frees its testbed at once, but the cleanup automation only acts at `ends_at`. The worker sends a signed call to an owner configured URL (a new `CLEANUP` API key) so the automation can reset the testbed right then.
**Done when:** with a live `CLEANUP` key, cancelling or moving a Current booking sends one HMAC signed POST from the worker; Upcoming bookings and no key send nothing; a failing hook never affects a booking and shows as an audit row and a Needs attention badge; the URL and secret never leak.
- [x] Design it (spec): `/architect cleanup hook for labs that end early`
- [x] Build it: `/develop cleanup hook for labs that end early`
  - [x] Migration 0017, enums, and the `CLEANUP` key rules, masked URL, and badge (AC-1, 9)
  - [x] The thread: queue on a Current cancel, the handler, and the separate "cleanup hook" worker step (AC-2, 4, 5, 8, 10, 13)
  - [x] The move path and the 30 minute stale cutoff (AC-3, 12)
  - [x] Outcomes, failure audit, and the guarded badge (AC-6, 7), then tests and scans (AC-9, 11)
- [x] Verify it: `/check verify cleanup hook for labs that end early` (2026-10-26: console, a live worker run against a signed https receiver with a 200 and a 404, the audit row, and the Needs attention badge; the 500 retry and the move event are proven in tests only, and the learner screens by diff and tests, see `verify.md`)
- [x] Test it: `/test cleanup hook for labs that end early`
Enhancement queued (2026-10-26): the hook must also fire when a lab ends at its booked time, not only on an early end. Details in the spec 0021 Follow-up (marked ENHANCE) and in feature 24.
spec [0021](../specs/0021-cleanup-hook-early-end/index.md) · code in `server/db/bookings.ts`, `server/jobs/`, `server/catalog/api-keys.ts`, `worker/index.ts`, `db/migrations/0017_cleanup_hook.sql`

### 24. Nile Portal reset when a lab ends · needs a decision · Full
Follow up from features 22 and 23. After every lab, whether it ends at its booked time or early, a receiver signs in to that workshop's Nile Portal as its admin and resets the portal to a clean baseline through the portal's own API, so the next learner starts on an empty tenant. The 30 minute gap after each lab (feature 22) is the time the reset gets to finish. The hook from feature 23 only fires on an early end today, so the app must also send it when a lab ends normally. It deletes things, so it is Full tier: a wrong target or a wrong tenant is hard to undo.
**Done when:** with a live `CLEANUP` key, every lab that ends, at its booked time or early (cancel or move), resets that workshop's portal inside the 30 minute gap (every SSID except the protected one, all integrations, all Wired Access Management, Segments, DHCP, and RADIUS entries are removed); a repeat call finds nothing left and changes nothing; a call that fails shows in the existing audit row and Needs attention badge; no portal password, token, or hook secret appears in a log, payload, or error.
- [ ] Design it (spec): `/architect nile portal reset when a lab ends`
> Owner inputs (2026-10-26), for `/architect`:
> - Correction (2026-10-26): the reset runs after every lab, not only an early end, which is why the 30 minute gap exists. Spec 0021 sends nothing at the normal end on purpose, so the app needs a new event when a lab ends normally. The worker already completes ended bookings, which is the natural place to send it. `/architect` decides whether that is part of this feature or its own spec.
> - Reset list so far: all SSIDs except one (the portal gives that one no delete option), all integrations, all Wired Access Management, Segments, DHCP, RADIUS, and more. The owner will send the rest of the list later.
> - Five workshops, N = 1 to 5, each with its own portal admin `admin@nileworkshop-N.com`. The password is in `~/secrets/nileportal.pw` (to confirm it is the same for all five). Only workshop 1 (`nileworkshop-1.com`, portal `u1.nile-global.cloud`) is a testbed in the app today.
> - Proven on workshop 1 (2026-10-26): sign in goes through Authentik and gives the portal an `x-id-token`; the portal API lists SSIDs with `GET /api/v1/settings/ssids` and deleted a test SSID with `DELETE /api/v1/settings/ssids/:id` (204). The page's own code names its routes, so every other resource type needs its list and delete routes found the same way.
> - Open questions for the owner: (1) the full reset list and its order, since some items may depend on others (for example segments used by SSIDs); (2) which SSID is the protected one and how to recognise it; (3) delete by "everything except" or by a name rule; (4) portal addresses and passwords for workshops 2 to 5; (5) the reset must finish inside the 30 minute gap: how long it takes today per workshop, and what happens if it overruns (alert, hold the next lab); (6) how the receiver gets the token (a headless browser sign in, or the sign in steps without a browser) and where it runs (a new container behind Traefik was the leading idea); (7) what happens when a call fails halfway (retry, partial reset, alert); (8) a dry run mode that lists what it would delete without deleting; (9) a safety check that the testbed's domain matches the portal tenant before anything is deleted; (10) whether the app or the receiver maps a testbed to its portal admin account.

## Deferred
Out of scope for the current build pass, kept so the plan stays honest.
- **Error monitoring**: capture server and browser errors in production · needs a decision
- **Accessibility audit (WCAG 2.2 AA)**: a formal pass beyond the base components' keyboard and focus handling
- **Usage analytics**: bookings, utilisation per testbed, no shows · needs a decision
- **Hook API keys into the labs**: actually use the stored IDP and AI credentials (for example, a testbed's IDP or an AI service in the lab). The owner may drop this entirely, since Authentik groups already protect the labs · needs a decision
- **Booking controls**: admin approval of new learners, or booking limited to allowed email domains
- **Admin table sorting and pagination**: revisit search, sort, and paging once an admin list passes about 200 rows (Users is the likely first) · from spec 0005
- **Admin timezone setting**: let an admin change their own console timezone after it is set once from the browser · from spec 0008
- **Learner timezone setting**: let a learner change their account timezone from the manage page (today it is fixed at first booking or by an admin) · from spec 0011
- **Social card with headline text**: draw the landing headline into the link preview image (`opengraph-image.tsx` with a committed Inter font) if marketing wants text in previews · from spec 0009
- **Secret rotation script**: `secrets:rotate` encrypts every stored secret again under the active keyring key in one transaction; needed once something decrypts them · from spec 0006
- **Per mailbox Google grant**: replace the `GOOGLE` service account key (domain wide reach) with a refresh token for the HOL mailbox only · from spec 0013
- **Email breaker alert**: tell someone (a console banner or a note to the Ops BCC) when Google has rejected the HOL mailbox key for over an hour · from spec 0013
- **Audit log export**: a CSV of the filtered Audit Log view, writing its own audit entry; deferred by owner choice on 2026-10-20 · from spec 0016
- **Audit log search index**: add a `pg_trgm` index on `audit_events.summary` if free text search slows down (around a million entries) · from spec 0016
- **Reconciler grant target fallback**: drop `booking?.bookingId ?? testbed.id` in `access.granted` so a testbed id can never be stored as a booking target (unreachable today) · from spec 0016
- **Updated access email**: when an admin changes a testbed's URLs or client logins (`testbed.updated` with `accessChanged`), email the new access details to learners with Upcoming or Current bookings on it · from spec 0007
- **OS logins in the calendar invite**: whether the `.ics` should also carry the client OS logins; left out on 2026-10-20 because an invite stays in calendars indefinitely · needs a decision · from spec 0007
- **Provisioning role least privilege**: remove `add_group` and `delete_group` from the provisioning role once the Playwright tests have their own credential for test groups; closes the marker's residual risk. A shared Authentik change the owner approves · from spec 0017
- **Group missing signal**: make a testbed whose group vanished or lost its marker visible (an audit row once per outage, or a badge on the list); today only the worker log shows it, by owner choice on 2026-10-23 · from spec 0017
- **Group column cleanup**: rename `authentik_group_deleted_at` to a "released" name, and consider dropping `testbeds.slug`, once no old worker can run · from spec 0017

## Legend

**The decision box.** Every feature carries exactly one, the sub task whose label ends with `(spec)`. Its wording varies (`Design it (spec)` normally, `Decide the stack (spec)` on Stack & architecture), so skills locate it by that `(spec)` suffix, never by an exact label. Every other box is an execution box and `/architect` never ticks one.

**Feature lifecycle**: the scope updates as a feature moves; each row is what it shows and who sets it:

| State | Set by | The feature shows |
|---|---|---|
| `planned` · needs a decision | `/scope` | one box: `Design it (spec): /architect <feature>` |
| `in-progress` (designed) | **`/architect` at spec capture** | `Design it` ticked; spec linked; `Build it: /develop <feature>` + **2 to 5 milestones rolled up from the spec**; `Verify it` + `Test it` boxes; any surfaced follow up enrolled |
| `in-progress` (building) | `/develop` | milestone sub boxes tick one by one; code pointer filled |
| `in-progress` (verified) | `/check verify` | `Build it` + milestones ticked; `Verify it` ticked |
| `done` | the tier's last required stage (`Vibe` → `/develop`; `Lean` → `/check verify`; `Medium`/`Full` → `/test`), then `/sync` | the tier's required boxes ticked; `/sync` captures the slice's conventions into `AGENTS.md` |

- **Next step** = the first unticked box (always a command or a tracked milestone).
- **needs a decision** = run `/architect` first; otherwise straight to `/develop` (or `/audit` for standards & tooling). The tag drops once the spec is captured.
- **Atomic build tasks live in the spec's `## Build plan`, not here**: the scope carries only the milestone rollup.
- **Status** `planned` → `in-progress` → `done`, plus `existing` (pre workflow) and `dropped` (de scoped, kept for history).
- **Approach tag** beside a heading (e.g. `· Facade`) overrides the project default for that feature; no tag = inherits it.
- **Workflow tier tag** beside a heading (e.g. `· Full`, `· Vibe`) overrides the project default `**Workflow:**` tier for that one feature; no tag = inherit.
- **Workflow** (header line) is the project default tier, the stages each feature runs **after** `/develop`: **Vibe** = nothing after `/develop`; **Lean** = `/check verify`; **Medium** = `/check verify` then `/test`; **Full** = `/check verify`, `/test`, a fresh model `/check review`, then `/document`. The tier also sets what closes a feature to `done`. At every tier an `Assumed` spec still blocks `done` until `/architect` ratifies it.
- **Pointer line** (`spec <n> · code in <path>`): the spec link added by `/architect`, the code path by `/develop`.

## References

**Project sources**
- `context/Nile HOL Lab Access Email Standalone.html`: the booking (lab access) email as a standalone, email-client-ready HTML file (sample data for Priya, Testbed 1).
- `context/Nile HOL Cancellation Email Standalone.html`: the cancellation email as a standalone, email-client-ready HTML file (sample data for Priya, Testbed 1).
- `context/reservations_mock.html`: learner and admin mocks (screens, fields, sample data, booking flow, delete blocking rules, booking status logic, the in-app previews of the booking and cancellation emails, and the admin "Sign in with SSO" page).
- The existing Next.js 16 scaffold and its root `AGENTS.md` / `CLAUDE.md`.
- Product owner answers in the scoping session (Authentik, guest booking with email link verification, booking rule, notifications, Medium workflow).

**Practices & standards**
- Foundations before features; data model is the costliest thing to redo.
- Vertical slices (Tracer Bullet) retire the integration risk first.
- Auth and secret handling get a higher rigor tier than ordinary CRUD.
- One decision per spec; an umbrella spec (email delivery) for decisions that dependents share.
