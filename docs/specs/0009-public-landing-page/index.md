# 0009. Public landing page

**Date**: 2026-10-11
**Status**: In Progress

## Summary

The home page at `/` becomes the learner landing from the mock. It has a hero with "Reserve a lab" (to `/book`) and "Manage an existing reservation" (to `/reservations`), the hero art, and three cards that explain the steps. It renders on each request but reads no session and touches no database, so it still loads when the database is down. Only `/` is open to search engines. It gets a title, a description, a social card (the image link previews show), a canonical URL, `robots.txt`, and a one page sitemap, while every other page is `noindex` (kept out of search results) by default. Every learner page also gets a small Nile footer copied from the emails.

## Requirements

**User stories**:
- As a visitor with no account, I want to see what Nile Hands-On Labs offers and start a booking in one click, so that I can get onto real gear quickly.
- As a returning learner, I want a clear way to manage my reservation from the home page, so that I can find my booking without hunting for a link.
- As the product owner, I want `/` to show up well in search results and link previews, while the flow pages and the admin console stay out of search.

**Acceptance criteria**:
- **AC-1**: `/` renders the same page for an anonymous visitor, a signed in learner, and a signed in admin. There is no redirect and no Sign out button (as in the mock, Sign out shows only in the learner area). Neither the page nor its frame calls `currentSession()` or the database.
- **AC-2**: The hero shows, in order: the eyebrow "Nile Hands-On Labs", the `h1` "Get hands-on with real Nile gear, from anywhere.", the lead paragraph from *Copy*, then two links. "Reserve a lab" goes to `/book` (the `cta` gradient pill) and "Manage an existing reservation" goes to `/reservations` (the `outline` pill). Both are real `<a>` elements, so they work without JavaScript.
- **AC-3**: Below the hero, three cards show the titles and bodies from *Copy*, each with its icon (`LayoutGrid`, `Calendar`, `Router` from lucide, `aria-hidden`). A visually hidden `h2` "How it works" comes before them, and each card title is an `h3`.
- **AC-4**: The hero art is `public/brand/hol-hero.jpg`, the mock's 1920×1080 JPEG byte for byte (its sha256 matches the decoded mock asset, recorded in `verify.md`). It renders through `next/image` as decoration (`alt=""`), at most 520px wide, beside the text at 1280px and below the buttons at 390px. Its `sizes` is the one in *Page contract*, so at 390px wide the loaded `currentSrc` has a `w` below 1920.
- **AC-5**: Every page that uses `LearnerFrame` (`/`, `/book`, `/reservations` signed out and signed in, `/auth/error`) ends with a `<footer>` after `<main>`. It reads "Nile Hands-On Labs · nilesecure.com" (the second part is an always underlined link to `https://www.nilesecure.com`), then "Copyright © <year> Nile. All rights reserved.", where `<year>` is the server's current UTC year at render. Admin pages and the admin entry page have no footer. The pairs `fg2` on `cloud-mist` and `primary` on `cloud-mist` are added to the contrast test and pass 4.5:1.
- **AC-6**: `/` sends these head tags:
  - The title is exactly "Nile Hands-On Labs", set as `title: { absolute: ... }` so the root template adds no suffix.
  - The meta description is the *Description* from *Copy*.
  - `<link rel="canonical">` is `APP_URL + "/"`, and robots is `index, follow`.
  - Open Graph: `og:type` is `website`, `og:site_name` and `og:title` are "Nile Hands-On Labs", `og:description` is the same as the meta description, and `og:url` is `APP_URL + "/"`. `og:image` is the absolute `APP_URL + "/brand/hol-social.jpg"` with width 1200, height 630, and alt "Nile Hands-On Labs".
  - `twitter:card` is `summary_large_image`, with the same title, description, and image.

  Every URL above is exactly `${APP_URL}/` or `${APP_URL}/brand/hol-social.jpg` (one slash, no doubling). A request with the link preview user agent `facebookexternalhit/1.1` gets all of these tags inside `<head>` of the raw HTML. For an ordinary browser Next may stream them later into the page, which is fine. Fetching the `og:image` URL returns 200, `image/jpeg`, 1200×630, under 500 KB.
- **AC-7**: Every page except `/` is `noindex, nofollow` by default, set once in the root layout's metadata, and `/` alone opts in. `/book`, `/reservations`, and `/auth/error` all emit the `noindex` robots meta tag. Admin paths keep their `X-Robots-Tag: noindex, nofollow` header (spec 0003 AC-3).
- **AC-8**: `/robots.txt` allows `/`, disallows `/admin` and `/api/`, and points to `APP_URL + "/sitemap.xml"`. It never contains `ADMIN_ENTRY_PATH` or `/auth/admin-entry`. `/sitemap.xml` lists exactly one URL, `APP_URL + "/"`.
- **AC-9**: No environment variable is read during `next build`. `/`, `/robots.txt`, and `/sitemap.xml` all export `dynamic = "force-dynamic"`, and the build output marks each as dynamic (`ƒ`). A `next start` run with `DATABASE_HOST` pointed at an unreachable address still serves `/`, `/robots.txt`, and `/sitemap.xml` with 200 (checked once in `verify.md`). No learner facing page links to `ADMIN_ENTRY_PATH` or shows an admin sign in or sign up control (spec 0003 AC-3 still holds).
- **AC-10**: `@axe-core/playwright` finds no serious or critical violation on `/` at 1280px and at 390px. The skip link reaches `<main id="content">`, and the headings run `h1`, then `h2`, then `h3`. Playwright captures `/` at 1280×800 and 390×844, and `/check verify` compares the shots with the mock's home screen, accepting only the differences listed in *Allowed differences from the mock*.

## Decision

**Chosen option**: Option 1: a request time landing with no session or database read, absolute metadata built from `APP_URL`, and the root layout set to `noindex` by default.

`/` is a Server Component in the existing `LearnerFrame` with Sign out turned off. It is `force-dynamic`, and its `generateMetadata` reads the public origin from a new narrow `appUrl()` helper. `robots.ts` and `sitemap.ts` are `force-dynamic` too, and the root layout makes `noindex` the default, so only `/` gets indexed.

**Implementation skills**: `vercel-react-best-practices` (`vercel-labs/agent-skills`, `.claude/skills/vercel-react-best-practices/`) · `shadcn` (`shadcn-ui/ui`, `.claude/skills/shadcn/`) · `tailwind-design-system` (`wshobson/agents`, `.claude/skills/tailwind-design-system/`) · `vitest` (`antfu/skills`, `.claude/skills/vitest/`) · `playwright-best-practices` (`currents-dev/playwright-best-practices-skill`, `.claude/skills/playwright-best-practices/`)

## Rationale

Reasoning and options: see [rationale.md](rationale.md).

## Feature design

**Data model sketch**: none. This feature adds no table, column, or migration.

**State transitions**: none.

**Page contract** (from the mock's home screen; the tokens and components come from `design.md`):

| Part | Content and layout |
|---|---|
| Frame | `LearnerFrame` with `showSignOut={false}`: the existing top bar (logo plus "Hands-On Labs", linking to `/`), the skip link, `<main id="content">`, and then the new footer |
| Hero section | Padding 64px 28px 40px. A centered grid up to 1080px wide, `repeat(auto-fit, minmax(min(100%, 320px), 1fr))`, gap 40px, items centered. Text column first, art column second, so the art stacks below the buttons on phones |
| Eyebrow | `<p>`, bold 12.5px, uppercase, 0.08em letter spacing, `nile-blue`, 14px below |
| Headline | `<h1>`, semibold, `clamp(30px, 8vw, 42px)`, line height 1.08, `-0.02em` tracking, `fg1` |
| Lead | `<p>`, 17px, line height 1.55, `fg2`, at most 480px wide, 28px below |
| Actions | A wrapping row with a 14px gap. Both are `next/link` styled with `buttonVariants({ size: "lg" })`, `variant: "cta"` for Reserve and `variant: "outline"` for Manage. Links, not buttons, because both navigate |
| Art | `next/image` of `/brand/hol-hero.jpg`, `width={1920} height={1080}`, `alt=""`, full width up to 520px, centered, `loading="eager"` (it sits above the fold at desktop width). Use `loading`, not the deprecated `priority`. `sizes="(min-width: 1136px) 520px, (min-width: 736px) calc((100vw - 96px) / 2), calc(100vw - 56px)"`: the grid goes to two columns at a 736px viewport (680px of content), and each column reaches 520px at 1136px |
| Steps section | Up to 1080px wide, centered, padding 20px 28px 80px. Grid `repeat(auto-fit, minmax(min(100%, 260px), 1fr))`, gap 20px. A visually hidden `<h2>How it works</h2>` comes first |
| Step card | White card, 1px `border`, 16px radius, 24px padding, `shadow-xs`. A 42px icon tile (12px radius, `nile-blue-050`) holds a 21px `nile-blue` icon, with 16px below it. Then an `<h3>` (16px semibold, `fg1`) and a `<p>` (13.5px, line height 1.5, `fg2`) |
| Footer | New `components/learner-footer.tsx`, rendered by `LearnerFrame` after `<main>`. A `<footer>` on `cloud-mist`, with a top `border` and padding 20px 28px. Two lines in 12.5px `fg2`, line height 1.6. The `nilesecure.com` link is `primary` and always underlined, and opens in the same tab. The emails show it without an underline, but here color alone gives only 1.2:1 against the `fg2` text around it, which fails axe's `link-in-text-block` rule |

**Copy** (product strings; keep these exact, hyphens included):

| Slot | Text |
|---|---|
| Eyebrow | `Nile Hands-On Labs` |
| `h1` | `Get hands-on with real Nile gear, from anywhere.` |
| Lead | `Reserve a remote testbed with switches, access points, and wireless clients, and start testing in minutes. No hardware to ship, no VPN to configure.` |
| Reserve link | `Reserve a lab` |
| Manage link | `Manage an existing reservation` |
| Card 1 | `Pick a lab type` / `Choose the lab level that matches what you're testing.` |
| Card 2 | `Choose an open time` / `See real-time availability in your own timezone, 24/7.` |
| Card 3 | `Get instant access` / `Your lab links and session details arrive as soon as you book.` |
| Description (meta, `og:`, `twitter:`) | `Reserve a remote Nile testbed with switches, access points, and wireless clients, and start testing in minutes.` |
| Footer line 1 | `Nile Hands-On Labs · ` then the link `nilesecure.com` |
| Footer line 2 | `Copyright © <year> Nile. All rights reserved.` |

**Allowed differences from the mock**: copy with the em dashes reworded and the two card fixes above; the new footer (with its underlined link); the visually hidden `h2`; the AA adjusted CTA gradient and input border from spec 0005; focus rings.

**API surface** (no Server Actions, so `tests/server-actions-require.test.ts` needs no new allow list entry):

| Endpoint | Method | Key inputs | Key outputs | Auth | Key errors |
|---|---|---|---|---|---|
| `/` (`app/page.tsx`, `export const dynamic = "force-dynamic"`) | GET | none | landing HTML plus the AC-6 head tags | public, reads no session | 500 only if `APP_URL` is missing or invalid (`appUrl()` parses nothing else) |
| `/robots.txt` (`app/robots.ts`, `force-dynamic`) | GET | none | the AC-8 rules | public | same as above |
| `/sitemap.xml` (`app/sitemap.ts`, `force-dynamic`) | GET | none | one `<url>`: `APP_URL + "/"`, no `lastmod` | public | same as above |
| `/brand/hol-hero.jpg`, `/brand/hol-social.jpg` | GET | none | static files from `public/brand/` | public | 404 if missing |

**Value sourcing**:

| Action | Value produced / displayed | Source |
|---|---|---|
| `/` metadata | `metadataBase` | new `appUrl()` in `server/env.ts`: it parses only `APP_URL` through `authSchema.shape.APP_URL` (origin only), the same pattern as `adminEntryPath()`, so the public routes need none of the auth secrets. It is called inside `generateMetadata`, which runs per request because the page is `force-dynamic` |
| `/` metadata | canonical, `og:url`, `og:image`, `twitter:image` | relative values `"/"` and `"/brand/hol-social.jpg"` in `alternates.canonical`, `openGraph`, and `twitter`, made absolute by `metadataBase`. Not asserted: `og:locale` (unset) |
| `/` metadata | social card file | `public/brand/hol-social.jpg`: the throwaway extraction script crops the hero art to a 1080×567 box at left 840, top 230 (the whole Nile ball plus the ribbons), then scales it to 1200×630. Encode at JPEG quality 85, and step down by 5 until the file is under 500 KB. Any image tool works (Next already depends on `sharp`). The box may be nudged by eye; `verify.md` records the final box and quality |
| `/` metadata | title, description, alt text | *Copy* table above |
| `/` page | hero art | `public/brand/hol-hero.jpg`: in `context/reservations_mock.html`, the `D.c` page (the customer view), then its `<script type="__bundler/manifest">` JSON, then asset `b7f58e0c-2e1c-4a0c-9300-ada9499e5249` (`image/jpeg`, not compressed), base64 decoded and written unchanged. Extracted by a throwaway script kept outside the repo, the same way spec 0005 extracted the logos. `verify.md` records its sha256 |
| `/` page | CTA targets | constants `/book` and `/reservations` |
| `/` page | Sign out hidden | `LearnerFrame` prop `showSignOut={false}`. With it off, the frame skips `currentSession()` entirely |
| Footer | year | `new Date().getUTCFullYear()` at render. This is display only, not a booking, slot, or access decision, so the "database is the clock" rule does not apply. Say so in a one line comment |
| `robots.txt` | sitemap URL, rules | `` `${appUrl()}/sitemap.xml` ``; rules are constants in `app/robots.ts` |
| `sitemap.xml` | the one URL | `` `${appUrl()}/` `` |
| Root layout | default `noindex` | `robots: { index: false, follow: false }` in `app/layout.tsx` metadata. `/` overrides it with `{ index: true, follow: true }` |

**Key invariants**:
- `/` and the frame in `showSignOut={false}` mode never call `currentSession()`, `db()`, or `auth()`. The frame still imports `server/auth/require.ts`, which is fine because those modules connect only when called.
- Nothing on the public surface (page, footer, `robots.txt`, sitemap) names `ADMIN_ENTRY_PATH` or `/auth/admin-entry`.
- `noindex` is the default. A page becomes indexable only by explicitly opting in, and today that is `/` alone. `/auth/error` and the admin entry keep their own `noindex` lines (redundant, harmless).
- No env read at module scope or during `next build`. Every `appUrl()` call sits in a `force-dynamic` route.
- `metadataBase` is set on `/` only. Any other page that later adds a relative URL field needs it too, or `next build` fails.

**Security model**: everything here is public and read only. It handles no PII, has no forms or actions, and reads no session, so there is nothing to authorize and no audit row to write. There is no app side rate limit: the page makes no database or Authentik call, so the only cost is bandwidth, and Cloudflare in front absorbs that. `robots.txt` naming `/admin` is acceptable, since that path is not secret and `requireAdmin()` guards it; the unlisted entry path never appears.

**Configuration required**: none. This reuses `APP_URL`.

**Critical test scenarios** (Playwright in `e2e/landing.spec.ts`, plus the existing suites):
- Happy path: anonymous `/` shows the eyebrow, `h1`, lead, both links with the right `href`s, the three cards, and the art; clicking "Reserve a lab" lands on `/book`. Verifies **AC-2**, **AC-3**, **AC-4**
- Same page for everyone: a signed in learner and a signed in admin (the existing session helpers) open `/`, see the same content, are not redirected, and see no Sign out. Verifies **AC-1**
- Metadata: assert every AC-6 tag through DOM locators (`page.locator('meta[property="og:image"]')` and so on), which work wherever Next streams them. Then make one `request.get("/")` with the header `User-Agent: facebookexternalhit/1.1` and assert the `og:` and `twitter:` tags sit in the raw `<head>`. Fetch `og:image` and check the status, type, size, and dimensions. `/book`, `/reservations`, and `/auth/error` carry `noindex`. Verifies **AC-6**, **AC-7**
- Crawl files: `/robots.txt` and `/sitemap.xml` match AC-8 and contain neither the live `ADMIN_ENTRY` value (from `e2e/authentik.ts`) nor `/auth/admin-entry`. Verifies **AC-8**, **AC-9**
- Footer: present with the current UTC year on `/`, `/book`, `/auth/error`, and `/reservations` (signed out, then signed in through the existing `signIn` helper). Absent on `/admin/testbed-types` (the existing admin session) and on the `ADMIN_ENTRY` page. Contrast pairs pass in `tests/design-contrast.test.ts`. Verifies **AC-5**
- Phone: at 390×844 (device scale factor 1), the art comes after the links in reading and visual order, and the `w` parameter of the image's `currentSrc` is below 1920. Verifies **AC-4**
- Accessibility: axe on `/` at 1280 and 390, the skip link, and the heading order. Verifies **AC-10**
- Build and outage (in `verify.md`, not Playwright): `npm run build` lists `/`, `/robots.txt`, `/sitemap.xml` as `ƒ`. Then `next start` with `DATABASE_HOST=127.0.0.2` (nothing listens there) serves all three with 200. Verifies **AC-1**, **AC-9**

## Build plan

Tracer Bullet: first a thin real `/` with its metadata, proved end to end by Playwright, then the indexing, footer, and polish strands.

1. Assets: run a throwaway script outside the repo that decodes the mock's hero JPEG into `public/brand/hol-hero.jpg` unchanged and crops `public/brand/hol-social.jpg` (1200×630, under 500 KB) per *Value sourcing*. Note the hero's sha256 and the crop box and quality for `verify.md`. Satisfies **AC-4**, **AC-6**
2. Landing tracer: add `appUrl()` to `server/env.ts`. Add `showSignOut?: boolean` (default `true`) to `LearnerFrame`, skipping `currentSession()` when it is false. Replace `app/page.tsx` (`force-dynamic`) with the *Page contract* and *Copy*. Add `generateMetadata`: `metadataBase` from `appUrl()`, `title: { absolute }`, the description, `alternates.canonical: "/"`, robots `index, follow`, and `openGraph` and `twitter` per AC-6. Write `e2e/landing.spec.ts` for the content, the links, the same page signed in, no admin link, and the metadata (DOM plus the bot user agent fetch, and the `og:image` fetch). Satisfies **AC-1**, **AC-2**, **AC-3**, **AC-4**, **AC-6**, **AC-9**
3. Indexing strand: add the root layout `robots` default (`noindex, nofollow`). Drop `/book`'s own `robots` line and its "until feature 11" comment, since the root default now covers it. Leave `/auth/error` and the admin entry as they are. Add `app/robots.ts` and `app/sitemap.ts` (`force-dynamic`, built from `appUrl()`). Extend the landing spec with the `noindex` checks on `/book`, `/reservations`, and `/auth/error` and the crawl file checks. Run the build check and the unreachable database check for `verify.md`. Satisfies **AC-1**, **AC-7**, **AC-8**, **AC-9**
4. Footer strand: add `components/learner-footer.tsx` (underlined link), render it in `LearnerFrame` after `<main>`, and add the pairs `fg2` and `primary` on `cloud-mist` to `pairs()` in `tests/design-contrast.test.ts` and to the *Contrast pairs* list in `design.md`. Add a `LearnerFooter` row to `design.md`'s component table. Add the Playwright footer checks from *Critical test scenarios*. Satisfies **AC-5**
5. Accessibility and screenshots: add `/` at 1280 and 390 to `e2e/a11y.spec.ts`. Add `/` at 1280×800 and 390×844 to `e2e/screenshots.spec.ts`. Re-run the suite so the captured `/book` shots include the footer (they are captures for the human comparison in `verify.md`, not saved baselines). Satisfies **AC-10**, **AC-5**

## Consequences

**Positive**:
- The landing survives a database or Authentik outage, because it depends on neither.
- `noindex` by default means a new page can't leak into search by accident.
- The footer gives every learner page the same Nile sign off as the emails.
- No new dependency, env var, or migration.

**Negative / tradeoffs**:
- `/` renders on every request instead of being served as a prebuilt file. The cost is small (no I/O), but it gives up a CDN cacheable static page.
- The footer changes every learner page, so the spec 0005 `/book` screenshots must be captured again.
- The footer link is underlined, unlike in the emails, because color alone fails AA against the text around it.
- A new env helper (`appUrl()`) sits beside `authEnv()`, so `APP_URL` is parsed in two places (both from the same schema field).
- The social card has no headline text. The preview shows the page title beside it instead.
- The hero JPEG is mostly blank on its left side. `next/image` keeps the download small, but the art looks smaller than its file.
- `robots.txt` shows that `/admin` exists. That's acceptable, because the path is guarded, not secret.
- The footer year comes from the server clock. If a learner page is ever prerendered, its year is the build year until the next deploy.

**Neutral**:
- This resolves spec 0004's "`/book` is `noindex` until feature 11 decides on SEO": `/book` stays `noindex`, now through the root default.
- It closes spec 0005's follow-up to extract the hero image.
- Feature 12 rebuilds `/book` in place, so the "Reserve a lab" link never changes.

## Follow-up

- [ ] `LearnerFrame` still passes the deprecated `priority` to the logo `Image` (Next 16 replaced it with `preload`). Switch it to `loading="eager"` the next time the frame is touched (likely while doing step 2).
- [ ] Feature 15: the email templates hard code "Copyright © 2026". Render the year the same way as this footer.
- [ ] Optional later: a social card with the headline drawn in (`opengraph-image.tsx` with `ImageResponse` and a committed Inter TTF), if marketing wants text in link previews.
