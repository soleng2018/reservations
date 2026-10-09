# Scope: Nile Hands-On Labs Reservations

A web app for Nile Hands-On Labs. Admins manage the remote lab catalog (testbed types, testbeds, API keys, and lab users). Learners book a remote testbed for a set time in three steps, then manage their bookings and open their lab access. Both views are designed in `context/reservations_mock.html`. The mock's Customer / Admin switcher (its "Customer" view is the learner view) is only there so both views can be seen in one file. It is not a feature of the app, where the role a user signs in with decides which area they see.

**Build approach:** Tracer Bullet (prove one real thread through every layer first, then thicken it one strand at a time).
**Workflow:** Medium (after `/develop`: `/check verify`, then `/test`). The project default rigor tier; architect still gates any feature that needs a decision at every tier; a feature's own tier tag (e.g. `· Full`) overrides it.

Decisions already made by the product owner (inputs for `/architect`, not open questions):
- Sign in for both admins and learners goes through one self hosted **Authentik** identity provider: the same instance and one OIDC application for both roles, with admins and learners told apart by role. The app talks to the Authentik API to configure itself and to create, update, and deactivate learners.
- The owner supplies two Authentik API keys, kept out of the app's database and UI:
  - a **master key**, used only to set up the app's OIDC SSO configuration in Authentik (provider, application, and anything else sign in needs).
  - if Authentik allows it, a separate **provisioning key** limited to learners: create, update, and deactivate learners, create and remove testbed groups, add and remove learners in those groups, and any other learner or testbed group task the app needs, but nothing that touches admins or the app's own sign in configuration. The app uses it for all day to day user calls and never uses the master key for them. If a key that narrow is not possible, `/architect` records the fallback and its risk.
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
- Authentik also protects the labs. Each testbed has its own Authentik group, which the app creates through the API when an admin adds the testbed (and removes when the testbed is deleted). The group grants access to the URLs listed on that testbed (Nile Portal, LMS, and client URLs). When a learner books and is assigned a testbed, the app adds the learner to that testbed's group. How each URL is put behind Authentik and bound to the group is for `/architect` to settle.
- Lab access lasts only for the booking window: the learner is added to the testbed's group when the booking starts, and access is terminated right after the lab time is over (or at once on cancel or deactivation). Terminating means removing the group membership and ending any open sessions to the testbed's URLs, so a learner who is already in the lab is cut off too, not just blocked from signing in again.
- API keys (IDP and AI credentials) and the testbed's IDP field are built as in the mock, but nothing uses them yet: they are stored and edited only. Testbed access always goes through the testbed's Authentik group, whatever IDP the testbed names. The owner expects these keys may never be needed; hooking them into the labs is a Deferred roadmap item.

## At a glance

| # | Feature | Phase | Status |
|---|---------|-------|--------|
| 1 | Stack & architecture | Foundation | done |
| 2 | Coding standards & tooling | Foundation | done |
| 3 | Data model | Foundation | done |
| 4 | Authentik sign in & provisioning | Foundation | done |
| 5 | Design system & UI foundation | Foundation | planned |
| 6 | Core booking loop | Slice 1 | in-progress |
| 7 | Admin: Testbed Types | Slice 2 | planned |
| 8 | Admin: API Keys | Slice 2 | planned |
| 9 | Admin: Testbeds | Slice 2 | planned |
| 10 | Admin: Users & user detail | Slice 2 | planned |
| 11 | Public landing page | Slice 3 | planned |
| 12 | Availability & booking rules | Slice 3 | planned |
| 13 | Manage reservations: sign in, cancel & reschedule | Slice 3 | planned |
| 14 | Lab access & booking result screens | Slice 3 | planned |
| 15 | Email delivery & booking confirmations | Slice 4 | planned |
| 16 | Set password / welcome email | Slice 4 | planned |
| 17 | Reminder before start | Slice 4 | planned |
| 18 | Admin audit log | Slice 5 | planned |

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

### 5. Design system & UI foundation · needs a decision
Take the Nile visual language from the mock (colors, type, logo, rounded cards and pills) and turn it into design tokens and base components: the admin shell with sidebar and mobile nav, searchable table, form modal, delete confirm, the "in use" blocked dialog, and the toast.
**Done when:** `design.md` covers tokens and components, the base components handle keyboard and focus, and the admin shell matches the mock at desktop and mobile widths.
- [ ] Design it (spec): `/architect design system & UI foundation`

## Slice 1: Core booking loop

### 6. Core booking loop · in-progress
The walking skeleton, real at every layer and as narrow as possible. An admin signs in and creates one testbed type and one testbed. A guest fills the mock's Step 1 form, picks a start time from a plain list, and confirms; the app creates their Authentik user and the booking together, and adds the user to the testbed's Authentik group. No calendar, landing page, emails, search, editing, or cancel yet.
**Done when:** that full path works against the real database and real Authentik; a failed step leaves nothing booked, no orphan user, and no stray group membership; a second guest cannot book the same testbed for an overlapping time.
- [x] Design it (spec): `/architect core booking loop`
- [ ] Build it: `/develop core booking loop`
  - [x] Admin tracer: shadcn init, pod group create, create only type and testbed forms with the row first group saga (AC-1, 2, 13)
  - [x] Guest tracer: slot math, saga step 1 rework with assignment and rollback, `/book` form and confirmation (AC-3, 5, 6, 7, 8, 9, 13)
  - [ ] Abuse guard and failure paths: rate limits, trusted IP, Turnstile, race and timeout tests (AC-2, 3, 4, 9, 10)
  - [x] Worker: lock, sequential loop, sweepers, and the access reconciler (AC-11, 12)
  - [x] Playwright happy path (AC-1, 2, 3, 5, 6)
- [ ] Verify it: `/check verify core booking loop`
- [ ] Test it: `/test core booking loop`
spec [0004](../specs/0004-core-booking-loop/index.md) · code in `app/book/`, `app/admin/`, `server/booking/`, `server/catalog/`, `server/worker/`, `worker/`, `lib/`
(basis: vertical slices prove the layers connect before breadth is added)

## Slice 2: Admin console (from the mock)

### 7. Admin: Testbed Types
List, search, add, edit, and delete testbed types (name plus a duration in hours or days), with a count of the testbeds that use each type.
**Done when:** the screen matches the mock; duration must be at least 1; deleting a type still used by testbeds is blocked and the dialog lists those testbeds.
- [ ] Build it: `/develop admin: testbed types`

### 8. Admin: API Keys · needs a decision · Full
List, search, add, edit, and delete IDP and AI credentials (name, type, base URL, secret). Secrets are entered once and are write-only afterward: the list shows only a fixed mask, and there is no reveal or copy. Editing a key leaves the secret unchanged unless the admin types a replacement. Keys are stored only; no part of the app calls them yet (see Deferred).
**Done when:** secrets are encrypted at rest and never sent back to the browser after they are saved; there are no reveal or copy controls (as in the mock); replacing a secret works from the edit dialog; deleting a key assigned to a testbed is blocked and the dialog lists those testbeds.
- [ ] Design it (spec): `/architect admin: api keys`

### 9. Admin: Testbeds · needs a decision
List, search, add, edit, and delete testbeds: name, type, IDP (chosen from IDP API keys, stored only and not used for access yet), Nile Portal URL, LMS URL, and a list of wired or wireless clients, each with a name and URL.
Saving a new testbed creates its Authentik group and protects its URLs with it; editing the URLs updates that protection; deleting the testbed removes the group.
**Done when:** the screen and form match the mock, including adding and removing client rows; a new testbed has its own Authentik group and its URLs are reachable only by members of that group; a failed Authentik step leaves no half created testbed; deleting a testbed with Upcoming or Current bookings is blocked and the dialog lists them.
- [ ] Design it (spec): `/architect admin: testbeds`

### 10. Admin: Users & user detail · needs a decision
List and search learners (name, company, email, booking count, status); admin accounts live only in Authentik and are not managed here. Add and edit learners, deactivate and reactivate them, and open a detail page with their bookings and statuses. Add, edit, and deactivate are synced to Authentik. The mock's generated password is dropped because Authentik owns credentials. Admins can cancel a booking from the detail page.
**Done when:** a user added here can sign in through Authentik; deactivating one blocks their sign in, frees their future bookings, and removes them from testbed groups, per the spec; the detail page shows Upcoming, Current, and Past bookings in the admin's timezone.
- [ ] Design it (spec): `/architect admin: users & user detail`

## Slice 3: Learner portal (from the mock)

### 11. Public landing page
The learner home from the mock: hero, "Reserve a lab" and "Manage an existing reservation" actions, and the three step explainer.
**Done when:** the page matches the learner mock, renders without sign in, and has its title, description, and social card metadata; it shows no admin sign in or sign up link.
- [ ] Build it: `/develop public landing page`

### 12. Availability & booking rules · needs a decision
Thicken slice 1's booking into the mock's full 3 step flow: details form with timezone choice, month calendar with unavailable days greyed, 30 minute start slots for the chosen day with the full duration highlighted, the confirm step showing the assigned testbed, and the progress and failure screens.
**Done when:** a learner sees only bookable days and times in their timezone; two learners booking the last free slot at once cannot both get it; an email that already has an active booking is stopped at Step 1 with a link to manage it.
- [ ] Design it (spec): `/architect availability & booking rules`

### 13. Manage reservations: sign in, cancel & reschedule
"Manage an existing reservation" from the mock: sign in through Authentik, see all bookings with status, reserve another when none is active, and cancel or reschedule Upcoming and Current bookings through the same calendar.
**Done when:** cancel frees the testbed at once (ending a Current booking early); reschedule either succeeds atomically or leaves the original untouched; Past bookings cannot be changed; a deactivated user cannot sign in.
- [ ] Build it: `/develop manage reservations`

### 14. Lab access & booking result screens · needs a decision
The success screen after booking or rescheduling, and the reservation detail page, both showing the testbed's Nile Portal, LMS course, and client links as in the mock.
Access is enforced by Authentik: the learner is in the assigned testbed's group for the booking, and is removed right after the lab time ends.
**Done when:** access details reach only the booking's own verified learner; a learner can open the testbed's URLs only during their booking window, and an open lab session stops working right after the lab time is over; cancel, reschedule to another testbed, and booking end update the group membership; Upcoming bookings show no detail link, Current and Past do; Past details show the links greyed out and unclickable with the "access is no longer active" note; the success screen tells a new learner to set their password from the email.
- [ ] Design it (spec): `/architect lab access & booking result screens`

## Slice 4: Notifications

### 15. Email delivery & booking confirmations · needs a decision
Set up email sending and shared templates (the umbrella that features 16 and 17 build on), then send a confirmation with a calendar invite on book, reschedule, and cancel, with times in the learner's timezone. Book, reschedule, and cancel use the mock's email templates.
**Done when:** book, reschedule, and cancel emails match the mock's templates and subjects, and render correctly in common mail clients; each of those three actions sends one correct email whose invite adds, moves, or removes the calendar event; a failed send never undoes the booking change.
- [ ] Design it (spec): `/architect email delivery & booking confirmations`

### 16. Set password / welcome email
The email a new user gets when their account is created, at guest booking or by an admin, carrying the set password link that also verifies their email.
**Done when:** each new user gets exactly one such email; the link expires, works once, and lands them signed in.
- [ ] Build it: `/develop set password email`

### 17. Reminder before start · needs a decision
A scheduled reminder email shortly before a booking starts.
**Done when:** each booking that is still active gets one reminder at the set lead time; a cancelled or rescheduled booking never gets a stale reminder.
- [ ] Design it (spec): `/architect reminder before start`

## Slice 5: Accountability

### 18. Admin audit log · needs a decision
Record who did what: API key secret creation and replacement, catalog changes, testbed group changes in Authentik, user deactivation, and booking cancellations by admins. Admins can view the log.
**Done when:** each of those actions writes an entry with actor, action, target, and time; entries cannot be edited from the app.
- [ ] Design it (spec): `/architect admin audit log`

## Deferred
Out of scope for the current build pass, kept so the plan stays honest.
- **Error monitoring**: capture server and browser errors in production · needs a decision
- **Accessibility audit (WCAG 2.2 AA)**: a formal pass beyond the base components' keyboard and focus handling
- **Usage analytics**: bookings, utilisation per testbed, no shows · needs a decision
- **Hook API keys into the labs**: actually use the stored IDP and AI credentials (for example, a testbed's IDP or an AI service in the lab). The owner may drop this entirely, since Authentik groups already protect the labs · needs a decision
- **Booking controls**: admin approval of new learners, or booking limited to allowed email domains

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
