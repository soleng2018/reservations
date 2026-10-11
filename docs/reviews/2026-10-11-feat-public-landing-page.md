# Review, feat/public-landing-page, 2026-10-11

**Reviewed by**: Sonnet 5.5 (author on a different model)
**Scope**: 19 files, branch vs main (landing page commits 5336bbc..e6baf07 only; features 0007 and 0008 not re-reviewed)
**Verdict**: Changes requested

## Summary

You turned `/` into the learner landing page, made `noindex` the default in the root layout, and added `robots.txt`, a sitemap, a footer on every learner page, and a thorough Playwright spec. The design is clean: `appUrl()` is narrow, the landing never touches the session or the database, and the admin entry does not leak anywhere. One real defect stands out: the "Manage an existing reservation" pill loses its border because `buttonVariants` is used without `cn()`. The rest is small spec wording drift and test hardening.

## Major

### 🟠 Outline pill renders with no border, `app/page.tsx:100`
**Problem**: Both hero links call `buttonVariants({...})` directly. The base classes contain `border border-transparent` and the `outline` variant adds `border-[1.5px] border-border-strong`. With no `tailwind-merge`, the two conflict in CSS and `border-transparent` wins. The runtime check confirmed a computed border colour of `rgba(0,0,0,0)`. Other pages (for example `app/admin/users/page.tsx:66`) wrap it in `cn()`, which is why this only shows up here.
**Why it matters**: The pill has a white `bg-card` background on a `#f6f8fb` page, so without its border it has almost no visible edge. That breaks the mock and spec AC-2 ("the `outline` pill"), and likely misses the 3:1 non text contrast bar for a control boundary. It is the secondary action for returning learners, so people will notice it.
**Suggested fix**: Wrap both calls in `cn(buttonVariants({...}))` (or use the `Button` component with `render` as other pages do). Add a small Playwright assertion that the link's `border-top-color` is not transparent so it cannot regress.

## Minor

### 🟡 Footer year test compares against the test machine's clock, `e2e/landing.spec.ts:262`
**Problem**: The test builds the expected year with `new Date().getUTCFullYear()` on the test runner, while the page uses the server's clock. They agree today because both run on the same host.
**Why it matters**: Around New Year, or if the runner and server ever differ, the test fails for no real reason. It also quietly uses the clock the project says not to trust.
**Suggested fix**: Assert the text matches `Copyright © \d{4} Nile. All rights reserved.` and that the year is within one of the runner's year, or read the year from the server's `Date` response header.

### 🟡 `test.skip` after assertions in the footer test, `e2e/landing.spec.ts:271`
**Problem**: In "every learner page ends with the Nile footer", the signed out checks run first, then `test.skip(!haveSecrets, ...)` fires. A machine without secrets reports the whole test as skipped even though the anonymous half ran and passed.
**Why it matters**: You lose the signed out footer coverage on exactly the machines that cannot sign in.
**Suggested fix**: Split into two tests, one anonymous and one signed in, and skip only the second.

### 🟡 Logo lost its preload hint, `components/learner-frame.tsx:36`
**Problem**: `priority` became `loading="eager"`. Per the Next 16 image docs this is the recommended swap, but it no longer inserts a preload `<link>`. That is a small behaviour change on every learner page and the landing's first paint.
**Why it matters**: Low. The logo is tiny. It is worth knowing the hint is gone, not a bug.
**Suggested fix**: Leave as is, or add `fetchPriority="high"` on the logo if you want the browser to raise it. Tick the matching follow up box in the spec.

### 🟡 `appUrl()` can produce the origin `"null"`, `server/env.ts:260`
**Problem**: `APP_URL` is `z.url().transform(u => new URL(u).origin)`. A non http URL such as `mailto:x@y` passes `z.url()` and its origin is the string `"null"`. Then `new URL(appUrl())` in `generateMetadata` throws, and `robots.txt` would print `null/sitemap.xml`.
**Why it matters**: Only a misconfigured deploy hits it, and `authEnv()` shares the schema, so it is an existing weakness. Still, the landing and crawl files now depend on it.
**Suggested fix**: Restrict the schema to `http` or `https` (for example `z.url({ protocol: /^https?$/ })`) so a bad value fails fast with a clear message.

### 🟡 Spec drift from the verify run, `docs/specs/0009-public-landing-page/index.md:26`
**Problem**: AC-6 and AC-8 say canonical and `og:url` are `APP_URL + "/"`, but Next renders the bare origin with no trailing slash. The test already encodes the bare origin. The sitemap `<loc>` does keep the slash. AC-6 and the *Interfaces* table also say a missing `APP_URL` gives a 500, but browsers get a 200 with no metadata because metadata streams; only bots and the crawl files get 500. The `priority` follow up is also done but still unchecked.
**Why it matters**: The spec is the contract future work reads, and it no longer matches behaviour.
**Suggested fix**: Reword AC-6 to "canonical and `og:url` equal `APP_URL` (Next writes the bare origin)", note the browser versus bot behaviour for a missing `APP_URL`, and tick the follow up.

## Nits

- ⚪ `components/learner-frame.tsx:11`, the doc comment line runs past 80 columns; rewrap it.
- ⚪ `e2e/landing.spec.ts:171`, the noindex test checks three pages and one admin path but never the admin entry page; fine, since that page sets its own robots, but a one line comment would say so.
- ⚪ `app/robots.ts:11`, `Disallow: /admin` stops crawlers from reading the admin `X-Robots-Tag`, so an externally linked admin URL could appear as a bare URL entry. The spec accepts this; consider mentioning it in the comment.

## Strengths

- `appUrl()` keeps the public routes free of auth secrets, and `force-dynamic` plus per request calls means `next build` reads no env. Build and outage behaviour were verified.
- `showSignOut={false}` really skips `currentSession()`, so the landing works with the database down and renders the same for every visitor.
- `noindex` as the root default with `/` opting in is the safe direction. I found no other page that accidentally opts in, and no learner facing link or crawl file names the admin entry.
- The e2e spec is strong: it checks raw `<head>` for a link preview bot, the social card's type, size and real JPEG dimensions, responsive `currentSrc`, and that the admin entry never appears in the HTML.
- The footer link is always underlined, with its contrast pair added to the contrast test and `design.md` kept in sync.

## Test coverage

Good. Landing content, links, both viewports, signed in versus anonymous, metadata (DOM and bot fetch), social card, noindex pages, robots and sitemap, footer, axe at two widths, skip link and heading order are all covered, and the contrast test gained the footer pair. Gaps: no assertion that the outline pill keeps a visible border (which is how the Major got through), and the footer year test is clock coupled as noted above. `appUrl()` has no unit test for a bad or missing value; the runtime check covered it by hand.
