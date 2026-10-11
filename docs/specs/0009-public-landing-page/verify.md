# Verify: Public landing page · spec 0009 · updated 2026-10-11
_Steps derived from spec 0009 acceptance criteria. `/check verify` runs these; `/test` locks the durable ones._

## Recorded during the build

- Hero art: `public/brand/hol-hero.jpg` is asset `b7f58e0c-2e1c-4a0c-9300-ada9499e5249` from the `D.c` page manifest in `context/reservations_mock.html`, base64 decoded and written unchanged. 1920×1080 JPEG, 335,710 bytes, sha256 `b6f7fbe96c2954847de041b63dedb35ade28a926e56e264b53349e93d7dda7dd`.
- Social card: `public/brand/hol-social.jpg` is the hero cropped to the box left 840, top 230, 1080×567 (no nudge), scaled to 1200×630 with sharp, JPEG quality 85 (first try under 500 KB), 58,812 bytes.
- `npm run build` on 2026-10-11 listed `/`, `/robots.txt`, and `/sitemap.xml` as `ƒ`.
- `DATABASE_HOST=127.0.0.2 npx next start -p 3100 -H 127.0.0.1` served `/` (200 `text/html`), `/robots.txt` (200 `text/plain`), `/sitemap.xml` (200 `application/xml`), and `/brand/hol-social.jpg` (200 `image/jpeg`), while `/book` gave 500, which shows the database really was unreachable.
- AC-6 as built: Next writes a URL whose path is only `/` as the bare origin, so `<link rel="canonical">` and `og:url` read `APP_URL` with no trailing slash (`resolve-url.js`, only the global `trailingSlash` option changes it). The engineer accepted this during `/develop`; AC-6's "exactly `${APP_URL}/`" wording is owed an update by `/architect`. `og:image` and `twitter:image` are `APP_URL/brand/hol-social.jpg` as specified.

## UI / manual

- [ ] Open `/` signed out → eyebrow "Nile Hands-On Labs", the `h1`, the lead, "Reserve a lab" (`/book`, gradient pill) and "Manage an existing reservation" (`/reservations`, outline pill), both real `<a>` → AC-2
- [ ] Turn JavaScript off and click each hero link → each navigates → AC-2
- [ ] Below the hero: a visually hidden `h2` "How it works", then three cards with `h3` titles, bodies from *Copy*, and `aria-hidden` lucide icons (`LayoutGrid`, `Calendar`, `Router`) → AC-3
- [ ] At 1280px the art sits beside the text, at most 520px wide; at 390px it sits below the buttons, and its `currentSrc` `w` is below 1920 (device scale factor 1) → AC-4
- [ ] Sign in as `hol-test-admin`, open `/` → same page, URL stays `/`, no Sign out → AC-1
- [ ] Sign in as `hol-test-learner`, open `/` → same page, URL stays `/`, no Sign out (Sign out still shows on `/reservations`) → AC-1
- [ ] View source of `/`: no `ADMIN_ENTRY_PATH` value, no `/auth/admin-entry`, no admin sign in or sign up control → AC-9
- [ ] Footer after `<main>` on `/`, `/book`, `/auth/error`, `/reservations` signed out and signed in: "Nile Hands-On Labs · nilesecure.com" (underlined link to `https://www.nilesecure.com`, same tab) and "Copyright © <current UTC year> Nile. All rights reserved." → AC-5
- [ ] No footer on `/admin/testbed-types` or on the admin entry page → AC-5
- [ ] Compare `e2e/screenshots/1280-landing.png` and `390-landing.png` with the mock's home screen; only the *Allowed differences from the mock* may differ. Check `1280-book.png` and `390-book.png` again now that the footer is there → AC-10, AC-5
- [ ] Tab once on `/` → "Skip to content" focused; Enter → `<main id="content">` focused; headings run `h1`, `h2`, `h3` → AC-10

## Commands

- [ ] `npx playwright test e2e/landing.spec.ts` → 9 passed (content, phone layout, both signed in roles, metadata and bot head, noindex, crawl files, footer present and absent) → AC-1 to AC-9
- [ ] `npx playwright test e2e/a11y.spec.ts e2e/screenshots.spec.ts` → all pass, no serious or critical axe violation on `/` at 1280 and 390 → AC-10
- [ ] `npx vitest run tests/design-contrast.test.ts` → passes with `fg2` and `primary` on `cloud-mist` (6.02 and 7.24) → AC-5
- [ ] `curl -s -A "facebookexternalhit/1.1" $APP_URL/ | sed -n '/<head>/,/<\/head>/p'` → every AC-6 tag inside `<head>`: title "Nile Hands-On Labs" (no template suffix), description, robots `index, follow`, canonical, `og:type` `website`, `og:site_name`, `og:title`, `og:description`, `og:url`, `og:image` (1200, 630, alt), `twitter:card` `summary_large_image`, `twitter:title`, `twitter:description`, `twitter:image` → AC-6
- [ ] `curl -sI $APP_URL/brand/hol-social.jpg` → 200, `image/jpeg`, under 500 KB, 1200×630 → AC-6
- [ ] `curl -s -A "facebookexternalhit/1.1" $APP_URL/book /reservations /auth/error` (each) → `<meta name="robots" content="noindex, nofollow"/>`; `curl -sI $APP_URL/admin/testbed-types` → `X-Robots-Tag: noindex, nofollow` → AC-7
- [ ] `curl -s $APP_URL/robots.txt` → `Allow: /`, `Disallow: /admin`, `Disallow: /api/`, `Sitemap: $APP_URL/sitemap.xml`, and no admin entry path → AC-8
- [ ] `curl -s $APP_URL/sitemap.xml` → exactly one `<loc>$APP_URL/</loc>` → AC-8
- [ ] `npm run build` → `/`, `/robots.txt`, `/sitemap.xml` marked `ƒ` → AC-9
- [ ] `DATABASE_HOST=127.0.0.2 npx next start -p 3100` → `/`, `/robots.txt`, `/sitemap.xml` all 200 (and `/book` 500, the control) → AC-1, AC-9

## Value sourcing

- [ ] `metadataBase` from `appUrl()`: start with `APP_URL=https://hol.example.com/some/path` → canonical, `og:url`, `og:image`, robots `Sitemap:`, and the sitemap `<loc>` all use `https://hol.example.com` (origin only, path dropped) → AC-6, AC-8
- [ ] `appUrl()` needs no auth secrets: start with `APP_URL` set but `AUTH_SECRET` and `AUTHENTIK_CLIENT_SECRET` unset → `/`, `/robots.txt`, `/sitemap.xml` still 200 → AC-9
- [ ] `APP_URL` missing → `/`, `/robots.txt`, `/sitemap.xml` give 500 (the only failure the API surface allows) → AC-9
- [ ] Canonical, `og:url`, `og:image`, `twitter:image`: no doubled slash, image URL is exactly `$APP_URL/brand/hol-social.jpg` → AC-6
- [ ] Social card file: dimensions and size above, and the Nile ball is whole in the crop → AC-6
- [ ] Title, description, alt: exactly the *Copy* strings, title not suffixed with " · Nile Hands-On Labs" → AC-6
- [ ] Hero art: `sha256sum public/brand/hol-hero.jpg` matches the recorded hash → AC-4
- [ ] CTA targets: `/book` and `/reservations` constants → AC-2
- [ ] Sign out hidden: with `showSignOut={false}` the frame never calls `currentSession()` (the outage run above proves `/` touches no database) → AC-1
- [ ] Footer year: render a learner page near midnight UTC on Dec 31 (or stub the clock) → the year is the UTC year, not the server's local year → AC-5
- [ ] Root `noindex` default: a page with no `robots` of its own (for example `/reservations`) emits `noindex, nofollow` → AC-7

## Acceptance-criteria coverage

- AC-1 covered by the two signed in steps, the outage command, Value sourcing "Sign out hidden"
- AC-2 covered by the hero link steps and Value sourcing "CTA targets"
- AC-3 covered by the cards step
- AC-4 covered by the layout step and the hero hash
- AC-5 covered by the footer steps, the contrast command, the screenshot recapture, and the footer year
- AC-6 covered by the bot head command, the image command, and Value sourcing (note the canonical and `og:url` slash above)
- AC-7 covered by the noindex command and the root default step
- AC-8 covered by the robots and sitemap commands
- AC-9 covered by view source, the build command, the outage command, and the `appUrl()` steps
- AC-10 covered by the axe command, the skip link step, and the screenshot comparison

## Pre-existing failures seen during the build (not this feature)

Both also fail on `a9fef24`, before any landing work:
- `e2e/booking.spec.ts:33`: strict mode violation, `getByRole('cell', { name: typeName })` matches 2 cells on Testbed Types.
- `e2e/isolation.spec.ts:148`: the Authentik login form for `leo` never appears (60s timeout).
