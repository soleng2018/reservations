# Verify: Design system and UI foundation · spec 0005 · updated 2026-10-10
_Steps derived from spec 0005 acceptance criteria. `/check verify` runs these; `/test` locks the durable ones._

Dev runs at `http://10.1.255.18:3000`. Admin steps sign in at `/l0gin` as `hol-test-admin`; learner steps use `hol-test-learner@example.test`.

## UI / manual
- [x] Open `/admin/testbed-types` at 1280px → fixed 248px Ink sidebar: white logo, divider, "Hands-On Labs", then API Keys, Testbed Types, Testbeds, Users, and Sign out pinned at the bottom; Testbed Types is the Nile Blue pill with `aria-current="page"` → AC-3
- [x] Same page → white full width header with "Testbed Types" (21px), the mock subtitle (13.5px, `fg3`), and an "Add type" pill; body on cloud mist, max 1180px → AC-3
- [x] Open `/admin/users/anything` (a 404 is fine) or `/admin/users` → Users stays the active item → AC-3
- [x] Resize to 390px → sidebar hidden, a 38px menu button named "Open navigation" with `aria-expanded="false"` → AC-4
- [x] Press the menu button → left drawer (248px, Ink) over a 45% Ink scrim; focus is inside and Tab cycles within it → AC-4
- [x] Close the drawer three ways (Escape, a scrim click, choosing a link) → it closes each time and focus returns to the menu button → AC-4
- [x] Open the drawer at 390px, then widen the window past 880px → the drawer closes → AC-4
- [x] At 390px on Testbed Types → the page never scrolls sideways; the table scrolls inside its card → AC-4
- [x] Visit `/admin` → redirects to `/admin/testbed-types` → AC-5
- [x] Visit `/admin/api-keys` and `/admin/users` → mock title and subtitle, no action button, an Empty state with the nav icon, "Coming in a later release." and "This section is being built." → AC-5
- [x] Sign in as the learner, open `/admin/testbeds` and `/admin/ui-gallery` → `?reason=not_authorized`, no Admin nav anywhere → AC-5, AC-13
- [x] Signed out, open `/admin/testbed-types` → redirected to the admin entry path, no shell → AC-5
- [x] On Testbed Types, type part of a name in the search box → rows filter case insensitively; a hidden live region reads "N results" / "1 result" / "No results" → AC-6
- [x] Search for "zzz" → "No testbed types match your search." → AC-6
- [x] In `/admin/ui-gallery`, the empty table → "No empty types yet. Add one to get started." → AC-6
- [x] Press "Add type" at 1280px → centered 520px modal, 20px radius, title, "Close" button, focus in Name → AC-7
- [x] Same at 390px → bottom anchored, full width, 20px top corners, at most 88vh, scrolls inside → AC-7
- [x] In the gallery modal, pick each outcome and Save: Field errors → messages under fields, values kept, focus on Name; Message error → destructive Alert above the footer; Throws → Alert "Something went wrong. Try again." and Save enabled again; Saved → modal closes, toast "Created <name>.", focus back on the trigger → AC-7, AC-9
- [x] While a gallery save is pending → Save shows a spinner and is disabled; Escape, Cancel and Close do nothing → AC-7
- [x] Close and reopen the modal after an error → empty form, no stale errors → AC-7
- [x] Real thread: on Testbed Types add `e2e <unique suffix>` (1 hour) → toast "Created e2e ….", the row appears without a reload and is found by search (the row stays in the shared database) → AC-7, AC-12
- [x] Gallery delete rows: Basic → blocked dialog with lock tile, "Testbed type in use", the message naming Basic, 8 items scrolling past 160px, one "Got it" → AC-8
- [x] Advanced → confirm dialog with warning tile, "Delete this?", `Delete "Advanced"? This can't be undone.`, Cancel focused first, solid red Delete; Delete → toast "Deleted." → AC-8
- [x] Okta Production → confirm, then Delete swaps to "API key in use" → AC-8
- [x] Nile Workshop 3 → error toast with the returned message; Expert → "Couldn't check whether this can be deleted. Try again."; Bench 9 and Bench 10 → "Something went wrong. Try again." → AC-8
- [x] Gallery toast buttons → success: Ink pill bottom center, 28px up, teal check, gone after 4s; error: crimson icon plus Close, gone after 8s; both pause while hovered or focused → AC-9
- [x] Open the admin entry path → the mock's sign in card (408px, 24px radius, sky glow, color logo 30px, eyebrow, "Sign in", subtitle, full width "Sign in with SSO" with lock icon, the SSO note); page is `noindex` → AC-10
- [x] Open `/`, `/book`, `/reservations`, `/auth/error` signed out → sticky white bar with the color logo, divider and "Hands-On Labs" linking to `/`; no Sign out → AC-11
- [x] Same pages signed in as the learner → "Sign out" with a log out icon on the right; Tab order is skip link, logo link, Sign out; each page has one `<main>` → AC-11
- [x] View source of each learner page → no link to the admin entry path → AC-11
- [x] Press Tab once on an admin page and on `/book` → "Skip to content" is focused first and jumps to `<main id="content">` → AC-14
- [x] Tab through the shell, a modal and the sign in card → every control shows a 2px ring outline with a 2px offset; on the Ink sidebar it is the sky outline → AC-14
- [x] Turn on reduced motion in the OS → the drawer, dialogs and toast appear without transitions → AC-14
- [x] Compare `e2e/screenshots/` with the mock at 1280 and 390 → only the *Allowed differences from the mock* differ; record the call here → AC-15
  - Call (2026-10-10, /check verify): matches. Compared side by side with the mock: sign in card, shell on Testbed Types (1280 and 390), form modal, blocked dialog, `/book` top bar. Differences seen are all allowed or required by the spec: darker input and search borders (AA), no "This screen is a mock" note, no Used By or Actions columns yet, "testbed(s)" now "testbeds", and the modal's "Name" label, sentence case title and default duration 1 (AC-12 keeps spec 0004's form). The mock has no confirm dialog state with its sample data, and its drawer and toast were not captured, so those three were checked against the spec's measurements instead (248px Ink drawer over a 45% scrim; Ink pill toast 28px from the bottom with a teal check). The round "N" badge in the shots is the Next.js dev overlay, not the app.
- [x] Open the root `design.md` → tokens (name, value, use), AA adjustments with ratios, type scale, radii, shadows, motion, component inventory with contracts, the error display rule, and the standard definition, linking spec 0005 → AC-16

## Value sourcing
- [ ] Nav items, order, icons, titles and subtitles all match `ADMIN_NAV` in `lib/admin-nav.ts`; change a subtitle there and the header follows → Value sourcing: admin shell
- [x] Active item comes from the path prefix: `/admin/testbeds` activates Testbeds, never Testbed Types → Value sourcing: active item
- [x] Layout switches by CSS at 880px; only an open drawer listens to `matchMedia` → Value sourcing: mobile or desktop
- [x] Gallery header shows the fixed AC-13 strings and is absent from the nav → Value sourcing: gallery header
- [x] Placeholder icons match each section's nav icon (lock for API Keys, users for Users) → Value sourcing: placeholder pages
- [ ] Table rows match `listTestbedTypes` / `listTestbeds` from the database; a testbed whose group is missing shows the neutral "Not ready" badge, otherwise `pod-<slug>` → Value sourcing: DataTable rows
- [x] Search text: types match on name and duration ("2 hours"); testbeds match on name, type name, and access group ("Not ready" too) → Value sourcing: search text
- [x] Placeholders: "Search testbed types…" and "Search by name, type, or access group…" → Value sourcing: placeholder, nouns
- [ ] The testbeds form's Type select lists exactly the live testbed types; with none, the field says "Add a testbed type first." → Value sourcing: testbeds form
- [x] The live region count equals the visible row count after each keystroke → Value sourcing: result count
- [x] The success toast text is the action's `message` (`Created <name>.`), not a client string → Value sourcing: success toast
- [x] Field errors land under the field named by their dotted path, including a client row (`clients.0.url`) → Value sourcing: field errors
- [x] With two invalid fields, focus goes to the first one in DOM order → Value sourcing: first invalid field
- [x] Blocked labels come from the check or delete result (testbed names, or learner names for reservations) → Value sourcing: blockers
- [x] Dialog copy follows `BLOCKED_COPY` per kind plus the row's label → Value sourcing: dialog copy
- [x] Sign out shows in the learner bar only when `currentSession()` returns a user → Value sourcing: learner Sign out
- [x] Gallery is a 404 with `NODE_ENV=production` (`npm run build && npm start`, sign in, open `/admin/ui-gallery`) → Value sourcing: gallery available
- [x] Logos load from `/brand/nile-logo.png` and `/brand/nile-logo-white.png` on the app's own origin → Value sourcing: brand

## Commands
- [x] `npm test` → passes, including `tests/design-contrast.test.ts` and `tests/style-guard.test.ts` → AC-1
- [x] Set `--color-fg3` back to `#6B8295` in `app/globals.css` and run `npx vitest run tests/design-contrast.test.ts` → fails on "fg3 on white" (then revert) → AC-1
- [x] `npm run test:e2e -- e2e/design-system.spec.ts` → passes (form modal, delete flow, keyboard, learner refusal, no font CDN) → AC-2, AC-4, AC-5, AC-7, AC-8, AC-9, AC-13, AC-14
- [x] `npm run test:e2e -- e2e/a11y.spec.ts` → no serious or critical axe violation on the AC-14 page list → AC-14
- [x] `npm run test:e2e -- e2e/screenshots.spec.ts` → writes the 1280 and 390 shots to `e2e/screenshots/` → AC-15
- [x] `npm run test:e2e -- e2e/booking.spec.ts` → passes through the new modals and "Save" (commits e2e test data to the shared database and Authentik) → AC-7, AC-12
- [x] `npm run test:e2e -- e2e/sign-in.spec.ts` → admin lands on `/admin/testbed-types` → AC-5
- [x] `npm run build` → succeeds; `/` and `/auth/error` are dynamic → AC-11

## Acceptance-criteria coverage
- AC-1: contrast and style guard tests, the fg3 revert command
- AC-2: no font CDN e2e, icons and title checked by hand, the logo source step
- AC-3: the shell steps at 1280px, active item steps
- AC-4: the 390px drawer steps, design-system keyboard spec
- AC-5: redirect, placeholders, learner refusal, signed out redirect
- AC-6: search, live region, empty and no match steps
- AC-7: form modal steps, real thread, design-system spec
- AC-8: gallery delete rows, design-system spec
- AC-9: toast steps, saved toast
- AC-10: sign in card step, a11y spec
- AC-11: learner frame steps, build command
- AC-12: real thread, testbeds rows and form steps, booking spec
- AC-13: gallery steps, production 404 step
- AC-14: skip link, focus ring, reduced motion, a11y spec
- AC-15: screenshot spec and the comparison step
- AC-16: the design.md step
