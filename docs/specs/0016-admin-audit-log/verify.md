# Verify: Admin audit log · spec 0016 · updated 2026-10-20
_Steps derived from spec 0016 acceptance criteria. `/check verify` runs these; `/test` locks the durable ones._

You can run these against the dev server on `http://10.1.255.18:3000`, signed in as `hol-test-admin`. Each step is a suggestion; skip any that a test below already proves to your satisfaction.

## UI / manual
- [x] Open the console as an admin. The nav lists API Keys, Testbed Types, Testbeds, Users, Audit Log, in that order, with the history icon on Audit Log; `/admin` still opens on Testbed Types → AC-1
- [x] Open `/admin/audit-log` signed out, then as `hol-test-learner`: both get the usual `requireAdmin` redirect and see no rows → AC-1
- [x] On Audit Log, rows read newest first, each with time, actor (with an Admin or Learner badge), action label and area, target, and summary → AC-2
- [x] Click Older, then Newer: the URL carries `before=` then `after=`; the newest page has no Newer link; an `after` page always shows Older → AC-3
- [x] Pick Who, Area, Admin, From, To, and type a search, then Apply: the URL holds each filter, rows match all of them, and the form shows what you picked → AC-4
- [x] Turn JavaScript off and apply a filter: the form still submits (plain GET) → AC-4
- [ ] Set From and To to the same day: only that day's rows in your timezone show; change your timezone (Users, your own row, or the console sync) and the edge rows move → AC-4
- [x] Search `50%` or `_`: only rows holding those characters literally match → AC-4
- [x] On a testbed type's row, click History: the log shows `target=testbed_type:<id>`, a "History for <name>" chip, and only that type's entries; × on the chip clears just that filter → AC-5, AC-9
- [x] On a booking's history (user detail page, a booking row's History link), the note "Access removals for this booking are listed in the learner's history." links to `?learner=<id>` → AC-5, AC-10
- [ ] Open `?learner=<a learner id>`: grants (booking target), revokes (user target), the learner's own reschedules or cancels, and admin edits each appear once → AC-5
- [x] A guest booking row reads "Booking form"; a reconciler grant or revoke reads "System"; a learner's own cancel links the learner's name to their user page → AC-6
- [x] Target names: a soft deleted type shows a Deleted badge, a booking reads "<learner> · <testbed> · <start>", a group reads "<testbed> access group", and every target links to its own history → AC-7
- [x] Expand a testbed type edit: it reads "Duration value: 2 → 3"; `api_key.secret_replaced` rows show no expand button; the button has `aria-expanded` and works with Enter and Space → AC-8
- [x] Testbed Types, Testbeds, API Keys, and Users rows each show a History icon link labelled "History for <name>" → AC-9
- [x] A learner's detail page shows a History section after Emails with up to 20 rows and a See all link to `?learner=<id>`; a learner with none reads "No history yet." → AC-10
- [x] The log has no edit, delete, or bulk control, and opening it adds no entry (reload twice, the top row stays the same unless something else happened) → AC-11
- [x] Every action label is sentence case ("Testbed type updated", "Access revoked", "Admin sign in refused") → AC-13
- [x] With filters that match nothing: "No entries match these filters." and a Clear filters link → AC-14
- [x] Open `/admin/audit-log?admin=nope&from=2026-10-21&to=2026-10-20&q=a&before=forged&after=forged`: the full page with one notice, "Some filters in this link weren't valid and were ignored.", never an error page → AC-14

## Value sourcing
- [ ] Entry time: shown in the signed in admin's `users.timezone`; change it and the times shift → Value sourcing (time)
- [ ] Actor: rename an admin in Authentik (or the DB) and every past row shows the new name; a null actor reads Booking form or System by action → Value sourcing (actor)
- [x] Action label and area come from `AUDIT_ACTION_INFO`; a legacy action name shows raw with no area → Value sourcing (action)
- [ ] Target name and Deleted badge follow today's row (rename a testbed, its past rows show the new name) → Value sourcing (target)
- [x] Summary shows exactly as stored → Value sourcing (summary)
- [x] Changed fields come from `metadata` through `describeMetadata` → Value sourcing (row detail)
- [x] The cursor round trips microseconds (two entries a microsecond apart page apart correctly) → Value sourcing (cursor)
- [x] From and To bounds use the admin's timezone (midnight in Los Angeles versus UTC give different rows) → Value sourcing (day bounds)
- [x] The Admin picker lists every `role = 'admin'` user by name → Value sourcing (admin picker)
- [x] The learner filter finds rows on all of that learner's bookings → Value sourcing (learner booking ids)
- [x] The booking note links to the booking's `user_id` → Value sourcing (booking note)
- [x] Chip names come from the same lookup as row targets → Value sourcing (chip)
- [x] History links carry the list row's own id and type → Value sourcing (History links)
- [x] The History panel shows the 20 newest learner entries → Value sourcing (History panel)

## Commands
- [x] `npm run db:codegen -- --verify` → "Generated types are up-to-date"; `pg_indexes` lists `audit_events_created_at_id_idx (created_at DESC, id DESC)` and no `audit_events_created_at_idx` → AC-15
- [x] `npx vitest run lib/audit-log.test.ts` → labels, areas, actor kinds (with the source scan of null actor writers), parsing, cursor, hrefs, describeMetadata pass → AC-3, AC-4, AC-5, AC-6, AC-8, AC-13, AC-14
- [x] `npx vitest run server/audit-log.test.ts` → first page, targets, the 120 row tie walk both ways, microsecond cursor, each filter, LA midnight, learner arms and paging, chips, learnerHistory pass → AC-2 to AC-7, AC-10
- [x] `npx vitest run server/audit-coverage.test.ts` → all 14 scoped actions write one entry with actor, action, target, and time → AC-12
- [x] `npx vitest run tests/audit-append-only-scan.test.ts` → no update, delete, or truncate of `audit_events` in app code; planted writes are flagged → AC-11
- [x] `npx vitest run lib/admin-nav.test.ts` → the new order, label, subtitle, and icon → AC-1
- [ ] `npx playwright test e2e/audit-log.spec.ts` → the edit, read, expand, filter, History, Older and Newer journey; the bad link notice; axe on the log and the History section; shots in `e2e/screenshots/{1280,390}-audit-log*.png` and `*-user-history.png` → AC-14, AC-16

## Acceptance-criteria coverage
- AC-1: UI steps 1, 2 · `lib/admin-nav.test.ts`
- AC-2: UI step 3 · `server/audit-log.test.ts`
- AC-3: UI step 4 · tie walk and microsecond tests · cursor unit tests
- AC-4: UI steps 5 to 8 · filter DB tests · parse unit tests
- AC-5: UI steps 9 to 11 · learner arm and chip DB tests · `parseTarget` unit tests
- AC-6: UI step 12 · actor unit tests (with the source scan) · actor filter DB test
- AC-7: UI step 13 · `resolveTargets` DB test
- AC-8: UI step 14 · `describeMetadata` unit tests
- AC-9: UI steps 9, 15 · Playwright journey
- AC-10: UI steps 10, 16 · `learnerHistory` DB test · Playwright axe test
- AC-11: UI step 17 · append only scan
- AC-12: `server/audit-coverage.test.ts`
- AC-13: UI step 18 · `AUDIT_ACTION_INFO` unit tests (and `satisfies` at compile time)
- AC-14: UI steps 19, 20 · parse unit tests · Playwright bad link test
- AC-15: Commands step 1
- AC-16: `e2e/audit-log.spec.ts`
