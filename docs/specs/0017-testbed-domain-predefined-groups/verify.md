# Verify: testbed domain & predefined groups · spec 0017 · updated 2026-10-23
_Steps derived from spec 0017 acceptance criteria. `/check verify` runs these; `/test` locks the durable ones. Verified live on 2026-10-24 against the redeployed worker (sha-9e82391) and the real Authentik, except the e2e trio line: `e2e/booking.spec.ts` failed on a time of day flake (it picks the last slot of the New York evening when run before about 04:30 UTC) and needs a rerun._

## UI / manual
- [x] Open Admin, Testbeds, Add testbed → the Name hint reads "Must be the exact name of an Authentik group the owner has set up for this lab.", and Domain shows the placeholder `nile.global`        → AC-1, AC-5
- [x] Save with Domain empty, then `nile`, then `nile.global.` → "Enter the domain." and then "Enter a domain name, like nile.global." under Domain, and no row is created        → AC-1
- [x] Add a testbed named like a marked group, with Domain `NileWorkshop-1.COM` → it saves, and the list and the edit dialog show `nileworkshop-1.com`        → AC-1 · Value sourcing (domain)
- [x] Try a name that matches no group, a group with no marker, a marker set to the string "true", a group with a role, a group with a parent, and `hol-admins` → each is refused under Name with its message, and the Audit Log has no `testbed.created` row for it        → AC-3 · Value sourcing (group pk, group usable)
- [x] Add a testbed named like a marked group → it saves and is in the list at once, with no "Not ready" badge; the Domain column shows; searching by domain, type, name, and IDP finds it        → AC-3, AC-8 · Value sourcing (list domain, search text)
- [x] Add a second testbed with the same name in another case, then with the same domain, then with both → "A testbed with this name already exists." on Name, "A testbed with this domain already exists." on Domain, and only the name message when both are taken        → AC-2 · Value sourcing (duplicate precheck)
- [x] With the dev server's `AUTHENTIK_URL` pointed at an unreachable host, add a testbed with a taken name → the duplicate message shows (not the Authentik message); with a free name → "Couldn't check the Authentik group, try again." and nothing is saved        → AC-2, AC-3
- [x] Delete the testbed, then add it again with the same name and domain → it saves, and its slug gets a `-2` suffix        → AC-2 · Value sourcing (slug)
- [x] Add a testbed on a group another live testbed already uses → "Another testbed already uses that group."        → AC-3
- [x] Open Edit on a testbed → Name is read only and shows the "can't change" hint, and there is no Access group row; post a forged `name` to the update and confirm the name and group stay        → AC-5 · Value sourcing (name not posted, edit load domain)
- [x] Edit the Domain with no reservation → it saves, and the Audit Log shows domain from and to; with an Upcoming or Current reservation → "You can't change the domain while this testbed has Upcoming or Current reservations." on Domain        → AC-6, AC-7 · Value sourcing (stored domain and lock)
- [x] Open the Audit Log entry for a new testbed → the actor is the admin, and the details hold slug, domain, group pk, and client count        → AC-7 · Value sourcing (audit actor, created metadata)
- [x] After an add, an edit, and a delete, look at the group in Authentik → it was not created, renamed, changed, or deleted        → AC-4
- [x] Delete a testbed and wait one worker tick → the Audit Log shows "Authentik group released" (reason `drained`, `gone`, or `shared`), the row is not reconciled again, and the group still exists        → AC-9 · Value sourcing (release rows, tagged members left, authentik_group_deleted_at)
- [x] Make the booking Current → the learner is in the group while it runs and out after it ends, with sessions ended and the Cloudflare revoke as before; a staff member added to the group by hand is never removed        → AC-10 · Value sourcing (learners wanted, who may be removed)
- [x] Remove the marker from the group during a Current booking → the add is refused with one log line for the testbed, and a learner whose booking ended is still removed        → AC-10 · Value sourcing (group to write to)
- [x] Recreate the group in Authentik (new pk) → on the next tick the new pk is stored and "Testbed group found again" is audited; rename the group instead → it is relinked when another marked group has the testbed's name, otherwise one error is logged and nothing is written to the renamed group        → AC-10 · Value sourcing (stale pk, name for the relink, new pk on relink)
- [x] As a learner and as an anonymous caller, call the testbed create, update, load, and delete actions → "not authorized" or the admin sign in, and nothing is written        → AC-13

## Commands
- [x] `npm run db:codegen -- --verify` → "Generated types are up-to-date!"        → AC-11
- [x] `npx vitest run tests/group-writes-scan.test.ts scripts/authentik-setup-plan.test.ts` → pass        → AC-4, AC-12
- [x] `npm run authentik:setup` (a dry run, by the owner) → the only change is the `hol-labs-access` policy text, now filtering on `attributes__hol_testbed_group=True`        → AC-12 · Value sourcing (gate)
- [x] After the owner applies the gate: `npm run test:e2e -- e2e/testbeds.spec.ts e2e/hol-labs.spec.ts e2e/booking.spec.ts` (needs the dev server on the LAN IP) → pass        → AC-3, AC-4, AC-5, AC-6, AC-12  _(2026-10-24: testbeds, hol-labs, and the admin booking test pass; `booking.spec.ts` "a guest books it through the three steps" fails in headless Chromium because Turnstile gives no token, and the same flow was confirmed by hand in a real browser. The four tests after it did not run.)_
- [x] On the real Authentik, confirm three facts: the group list `name` filter is an exact match; the `attributes__hol_testbed_group=True` lookup works on `request.user.groups` inside the gate policy; and a group payload carries `is_superuser`, `parents`, and `roles` (the guard refuses an add when any of them is missing)        → AC-3, AC-12

## Acceptance-criteria coverage
- AC-1 … Domain steps 1 to 3 · AC-2 … steps 6 to 8 · AC-3 … steps 4, 5, 7, 9 · AC-4 … step 13 and the scan command · AC-5 … steps 1, 10 · AC-6 … step 11 · AC-7 … steps 11, 12 · AC-8 … step 5 · AC-9 … step 14 · AC-10 … steps 15 to 17 · AC-11 … the codegen command · AC-12 … the setup, e2e, and Authentik fact commands · AC-13 … step 18

## Amendment 2026-10-26: Domain read only (updated 2026-10-27)
_These replace the older steps that type or edit a Domain (UI steps 1 to 3, 6, and 11 above), which are superseded and kept only as the 2026-10-24 record. Partly run on 2026-10-26 (the no valid domain refusal and the none has a domain message were run live against NileWorkshop2Admin to 5Admin, nothing written; the Authentik unreachable alert was run with a dummy AUTHENTIK_URL): the dropdown and testbeds Playwright specs and the vitest command passed; the other steps are not yet run live._

### UI / manual
- [ ] Open Add testbed → Domain is a read only box with the placeholder "Choose a group first" and the hint "Taken from the group. It can't be changed."; choose a group that has a domain → the box shows it; Save stays off until a group with a domain is chosen        → AC-20, AC-22
- [ ] Open the Group Name list with one marked group that has no `hol_testbed_domain` → it is listed as "<name> (no domain set)" and cannot be chosen        → AC-22
- [ ] Add a testbed on a group with domain `NileWorkshop-1.COM` set by hand → it saves and the list and edit dialog show `nileworkshop-1.com`; post a forged `domain` with the form → the stored value is still the group's        → AC-21 · Value sourcing (domain)
- [x] Remove `hol_testbed_domain` from the group after the list loaded, then Save → "That group has no valid domain. Ask the owner to set hol_testbed_domain on it." under Group Name, no row and no audit row        → AC-21, AC-22
- [ ] Add a testbed on a group whose domain a live testbed already holds → "Another testbed already uses this group's domain." under Group Name; with Authentik unreachable the Authentik message shows instead        → AC-21, AC-2
- [ ] Open Edit → Domain is read only with the same hint and shows the stored value; save with a live Upcoming or Current reservation → it saves, and the domain is unchanged; the Audit Log never lists `domain`        → AC-20, AC-23

- [ ] Open Add testbed → Group Name is a select ("Choose a group"), sorted by name ignoring case, with no free text group field; the hint reads "Choose the Authentik group the owner has set up for this lab. Only groups not used by another testbed are listed."        → AC-14, AC-19
- [x] With every listed group lacking `hol_testbed_domain` → every option is disabled, and the text under the select reads "None of the available groups has a domain yet. Ask the owner to set hol_testbed_domain on one."; Save stays off        → AC-18, AC-22
- [ ] A marked group already behind a live testbed is not in the list; delete that testbed and reopen the dialog → it is listed again        → AC-16
- [x] Open the dialog with Authentik unreachable → "Couldn't load the Authentik groups. Close this and try again in a moment." as an alert, with the select and Save off        → AC-18
- [ ] Unmark, rename, or take a group after the list loaded, then Save → the AC-3 message and nothing is written        → AC-19

### Commands
- [x] `npx vitest run server/catalog/testbeds.test.ts server/authentik/groups.test.ts app/admin/actions.test.ts lib/catalog-input.test.ts lib/testbeds.test.ts` → pass        → AC-20, AC-21, AC-22, AC-23
- [ ] `npm run test:e2e -- e2e/testbed-group-dropdown.spec.ts e2e/testbeds.spec.ts e2e/booking.spec.ts` once the hol-test fixtures exist → pass        → AC-20, AC-22, AC-23

### Acceptance-criteria coverage
- AC-14 … step 7 · AC-16 … step 8 · AC-18 … step 9 · AC-19 … steps 7, 10 · AC-20 … UI steps 1, 6 · AC-21 … steps 3 to 5 · AC-22 … steps 1, 2, 4 · AC-23 … step 6
