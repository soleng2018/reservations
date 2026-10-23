# Verify: testbed domain & predefined groups · spec 0017 · updated 2026-10-23
_Steps derived from spec 0017 acceptance criteria. `/check verify` runs these; `/test` locks the durable ones. Built and unit tested on 2026-10-23; the steps below that need the real Authentik, the worker, or a browser have not been run._

## UI / manual
- [ ] Open Admin, Testbeds, Add testbed → the Name hint reads "Must be the exact name of an Authentik group the owner has set up for this lab.", and Domain shows the placeholder `nile.global`        → AC-1, AC-5
- [ ] Save with Domain empty, then `nile`, then `nile.global.` → "Enter the domain." and then "Enter a domain name, like nile.global." under Domain, and no row is created        → AC-1
- [ ] Add a testbed named like a marked group, with Domain `NileWorkshop-1.COM` → it saves, and the list and the edit dialog show `nileworkshop-1.com`        → AC-1 · Value sourcing (domain)
- [ ] Try a name that matches no group, a group with no marker, a marker set to the string "true", a group with a role, a group with a parent, and `hol-admins` → each is refused under Name with its message, and the Audit Log has no `testbed.created` row for it        → AC-3 · Value sourcing (group pk, group usable)
- [ ] Add a testbed named like a marked group → it saves and is in the list at once, with no "Not ready" badge; the Domain column shows; searching by domain, type, name, and IDP finds it        → AC-3, AC-8 · Value sourcing (list domain, search text)
- [ ] Add a second testbed with the same name in another case, then with the same domain, then with both → "A testbed with this name already exists." on Name, "A testbed with this domain already exists." on Domain, and only the name message when both are taken        → AC-2 · Value sourcing (duplicate precheck)
- [ ] With the dev server's `AUTHENTIK_URL` pointed at an unreachable host, add a testbed with a taken name → the duplicate message shows (not the Authentik message); with a free name → "Couldn't check the Authentik group, try again." and nothing is saved        → AC-2, AC-3
- [ ] Delete the testbed, then add it again with the same name and domain → it saves, and its slug gets a `-2` suffix        → AC-2 · Value sourcing (slug)
- [ ] Add a testbed on a group another live testbed already uses → "Another testbed already uses that group."        → AC-3
- [ ] Open Edit on a testbed → Name is read only and shows the "can't change" hint, and there is no Access group row; post a forged `name` to the update and confirm the name and group stay        → AC-5 · Value sourcing (name not posted, edit load domain)
- [ ] Edit the Domain with no reservation → it saves, and the Audit Log shows domain from and to; with an Upcoming or Current reservation → "You can't change the domain while this testbed has Upcoming or Current reservations." on Domain        → AC-6, AC-7 · Value sourcing (stored domain and lock)
- [ ] Open the Audit Log entry for a new testbed → the actor is the admin, and the details hold slug, domain, group pk, and client count        → AC-7 · Value sourcing (audit actor, created metadata)
- [ ] After an add, an edit, and a delete, look at the group in Authentik → it was not created, renamed, changed, or deleted        → AC-4
- [ ] Delete a testbed and wait one worker tick → the Audit Log shows "Authentik group released" (reason `drained`, `gone`, or `shared`), the row is not reconciled again, and the group still exists        → AC-9 · Value sourcing (release rows, tagged members left, authentik_group_deleted_at)
- [ ] Make the booking Current → the learner is in the group while it runs and out after it ends, with sessions ended and the Cloudflare revoke as before; a staff member added to the group by hand is never removed        → AC-10 · Value sourcing (learners wanted, who may be removed)
- [ ] Remove the marker from the group during a Current booking → the add is refused with one log line for the testbed, and a learner whose booking ended is still removed        → AC-10 · Value sourcing (group to write to)
- [ ] Recreate the group in Authentik (new pk) → on the next tick the new pk is stored and "Testbed group found again" is audited; rename the group instead → it is relinked when another marked group has the testbed's name, otherwise one error is logged and nothing is written to the renamed group        → AC-10 · Value sourcing (stale pk, name for the relink, new pk on relink)
- [ ] As a learner and as an anonymous caller, call the testbed create, update, load, and delete actions → "not authorized" or the admin sign in, and nothing is written        → AC-13

## Commands
- [ ] `npm run db:codegen -- --verify` → "Generated types are up-to-date!"        → AC-11
- [ ] `npx vitest run tests/group-writes-scan.test.ts scripts/authentik-setup-plan.test.ts` → pass        → AC-4, AC-12
- [ ] `npm run authentik:setup` (a dry run, by the owner) → the only change is the `hol-labs-access` policy text, now filtering on `attributes__hol_testbed_group=True`        → AC-12 · Value sourcing (gate)
- [ ] After the owner applies the gate: `npm run test:e2e -- e2e/testbeds.spec.ts e2e/hol-labs.spec.ts e2e/booking.spec.ts` (needs the dev server on the LAN IP) → pass        → AC-3, AC-4, AC-5, AC-6, AC-12
- [ ] On the real Authentik, confirm three facts: the group list `name` filter is an exact match; the `attributes__hol_testbed_group=True` lookup works on `request.user.groups` inside the gate policy; and a group payload carries `is_superuser`, `parents`, and `roles` (the guard refuses an add when any of them is missing)        → AC-3, AC-12

## Acceptance-criteria coverage
- AC-1 … Domain steps 1 to 3 · AC-2 … steps 6 to 8 · AC-3 … steps 4, 5, 7, 9 · AC-4 … step 13 and the scan command · AC-5 … steps 1, 10 · AC-6 … step 11 · AC-7 … steps 11, 12 · AC-8 … step 5 · AC-9 … step 14 · AC-10 … steps 15 to 17 · AC-11 … the codegen command · AC-12 … the setup, e2e, and Authentik fact commands · AC-13 … step 18
