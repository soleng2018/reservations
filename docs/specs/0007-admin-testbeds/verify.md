# Verify: Admin Testbeds · spec 0007 · updated 2026-10-10
_Steps derived from spec 0007 acceptance criteria. `/check verify` runs these; `/test` locks the durable ones._

## UI / manual
On `/admin/testbeds`, signed in as hol-test-admin, at `http://10.1.255.18:3000`. Name anything you create `dev …`.

- [x] The list shows Name, Testbed type, IDP (`—` when none), Clients (`0 clients`, `1 client`, `3 clients`), and Actions, sorted by name ignoring case; there is no Access group column → AC-1
- [x] A testbed with a null `authentik_group_pk` shows a `Not ready` badge beside its name; its edit button is disabled with the tooltip "Still being set up"; its delete button still works → AC-1, AC-4
- [x] Search finds a testbed by name, type name, and IDP name, ignoring case; typing `—` finds nothing → AC-1
- [x] The page's HTML and network payload carry no client OS username or password (only counts) until an edit dialog opens → AC-1, AC-3
- [x] Add testbed: the IDP select lists live `IDP` keys only (no `AI` key, no deleted key) plus None, default None; a new client row defaults to Wireless; Add client turns off at 20 rows → AC-2
- [x] Save a client with an OS password and no username: the error "Enter the OS username for this password." shows under that row's OS username → AC-2
- [x] Save with a password that has spaces: it is stored exactly as typed; empty username and password are stored as null → AC-2
- [x] Delete (or change to `AI`) the chosen IDP key in another tab, then save the add or edit form: "That IDP key no longer exists." shows on IDP and nothing is written → AC-2, AC-3
- [x] Open edit: a loading state shows, then every field fills, including each client's OS username and password (masked, with a show toggle that sets `aria-pressed`); the access group `pod-<slug>` shows read only with "The owner binds this group to the lab's apps in Authentik." → AC-3
- [x] Soft delete the testbed's IDP key in the database, then open edit: the IDP select shows None → AC-3
- [x] Delete a testbed in another tab, then open its edit dialog: "This testbed no longer exists." shows and Save stays off → AC-3
- [x] Rename a testbed: the slug and group pk stay the same; the `testbed.updated` audit metadata holds only `name` (no `accessChanged`) → AC-3, AC-5
- [x] Change a client's OS password only: the save succeeds, the audit metadata holds `clients: { from, to }` and `accessChanged: true`, and no credential value appears anywhere in the audit row or the server log → AC-5
- [x] Change the Portal or LMS URL: the audit metadata holds that URL change and `accessChanged: true` → AC-5
- [x] Save without changing anything: "Updated <name>." shows, and no audit row is written → AC-3
- [x] Change the type of a testbed that has a Current booking: it saves, and the booking keeps its own `testbed_type_id`, start, and end → AC-3
- [x] Rename to another live testbed's name (other case): "A testbed with this name already exists." shows on Name → AC-3
- [x] Delete a testbed with a Current and an Upcoming booking: the blocked dialog "Testbed has active reservations" lists `<learner> — Current reservation` and `<learner> — Upcoming reservation`, by start; nothing changes → AC-6
- [x] Delete a testbed with only Past bookings: the confirm reads `Delete "<name>"? This can't be undone.`; after it, the row is gone, the testbed is not bookable, its name can be used again, its slug cannot; a `testbed.deleted` audit row holds `{ slug, groupPk }` (null groupPk for a not ready testbed) → AC-6
- [x] Book the testbed between the delete check and the confirm: the blocked dialog shows instead → AC-6
- [x] As a learner, and signed out, calling `loadTestbedForEdit`, `updateTestbedAction`, `checkTestbedDelete`, and `deleteTestbedAction` redirects to not authorized (or the admin sign in) and writes nothing → AC-9

## Commands
- [x] `npm run db:codegen -- --verify` → "Generated types are up-to-date!" → AC-8
- [x] `npx vitest run server/db/testbed-admin-schema.test.ts` → the four named checks refuse bad rows → AC-8
- [x] `npx vitest run tests/os-password-scan.test.ts tests/server-actions-require.test.ts` → pass (the allow list is unchanged) → AC-9, AC-10
- [x] `npx vitest run server/worker/teardown.test.ts` → pass → AC-7
- [x] Delete a `dev-` testbed with no live bookings, then run the worker (`WORKER_ENABLED=true npm run worker`, the one production worker, stop it after a tick): its `pod-<slug>` group disappears from Authentik within a tick or two, the row gets `authentik_group_deleted_at`, and an `authentik_group.deleted` audit row (actor null, metadata `{ testbedId }`) appears; a second tick does nothing more → AC-7
- [x] `npx playwright test e2e/testbeds.spec.ts` → passes (add with IDP and two clients, edit, delete) → AC-1, AC-2, AC-3, AC-6

## Acceptance-criteria coverage
- AC-1 … list columns, badge, search, no OS logins in the list (UI steps 1 to 4; Playwright)
- AC-2 … add form, parse rules, IDP lock (UI steps 5 to 8)
- AC-3 … edit load, stale IDP, gone, no change, type change, duplicate (UI steps 9 to 11, 15 to 17)
- AC-4 … not ready edit (UI step 2)
- AC-5 … audit metadata, no credentials (UI steps 12 to 14)
- AC-6 … blockers with phases, delete, race (UI steps 18 to 20)
- AC-7 … worker teardown (Commands step 5, teardown tests)
- AC-8 … migration checks, codegen verify (Commands steps 1, 2)
- AC-9 … auth (UI step 21, Commands step 3)
- AC-10 … source scan (Commands step 3)
