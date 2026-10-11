# 0009. Public landing page: rationale

## Context

`/` is a placeholder today: a heading and one link inside `LearnerFrame`. Scope feature 11 asks for the mock's learner home (hero, two actions, three step explainer), which must render without sign in, carry title, description, and social card metadata, and show no admin sign in or sign up link. Spec 0004 left `/book` `noindex` "until feature 11 decides on SEO", and spec 0005 left the hero image extraction to this feature.

Forces that shaped the design:

- **The frame reads the session.** `LearnerFrame` calls `currentSession()` (a Better Auth lookup plus a `users` query) on every render, to show Sign out. The mock hides Sign out on its home screen.
- **The env rule.** AGENTS.md says no env read during `next build`. Absolute social card and canonical URLs need the public origin, and `APP_URL` is only validated at runtime.
- **Metadata inheritance.** File convention metadata (`app/opengraph-image.*`) at the root segment applies to every route below it, including pages that should never be shared or indexed.
- **One shared database and one web process behind Cloudflare.** The public front door should not go down with the database.
- **The mock's copy.** It has em dashes, hard codes lab type names that admins actually control, and promises "credentials ... right away", when a new learner first sets a password from an email.

## Options considered

### Option 1: Request time landing with no session or DB read (chosen)

`/` renders per request inside `LearnerFrame` with `showSignOut={false}`. `generateMetadata` calls `connection()` and builds absolute URLs from `APP_URL`. `robots.ts` and `sitemap.ts` are `force-dynamic`, and the root layout defaults to `noindex`.

**Pros**: it never reads env at build; it has no database dependency; it matches the mock (no Sign out on home); and the social card is set explicitly on `/` only.
**Cons**: there is no static CDN cacheable HTML, and a tiny render cost on each request.

### Option 2: Fully static landing with build time `metadataBase`

`/` is prerendered at build, and `metadataBase` reads `APP_URL` (or a new build arg) during `next build`.

**Pros**: it is the fastest possible response, cacheable at the edge.
**Cons**: it breaks the "no env during build" rule, and it bakes one origin into the image, so dev and prod (and any future host) need separate builds. CI builds would also need the URL.

### Option 3: Keep today's session reading frame

`/` reuses `LearnerFrame` unchanged and shows Sign out to signed in visitors.

**Pros**: the smallest code change, and signed in learners can sign out from home.
**Cons**: one database query per landing view, the landing fails when the database is down, and it diverges from the mock.

## Rationale

Option 1 is the only one that keeps both the env rule and the "front door survives a DB outage" property, and the per request cost is negligible at this app's traffic. Option 2's speed doesn't matter at this scale, and it costs a rule the project relies on to keep one image for dev and prod. Option 3 trades a real outage mode for a Sign out link the mock deliberately omits.

Choices made in the interview, with the reasoning for each:

- **Targets.** "Reserve a lab" goes to `/book`, which feature 12 rebuilds in place, so the link is stable. "Manage" goes to `/reservations`, which keeps the resend set password link on the way.
- **Copy.** The mock's words stay, with the em dashes reworded. Card 1 drops the hard coded "Basic, Intermediate, or Advanced", since admins name the lab types and the names would drift. Card 3 now promises "lab links and session details", which is true even before the password is set.
- **Hero art.** It is used unchanged for fidelity to the mock, and `next/image` keeps phone downloads small. Cropping was the runner up.
- **Footer.** The engineer chose the Nile footer from the emails, shown on every learner page through `LearnerFrame`, not only on `/`. The year is rendered rather than fixed, so it never goes stale.
- **Indexing.** Only `/` is indexed. The flow pages are steps, not entry points. Making `noindex` the root default (rather than per page) means future pages are safe by default; the runner up was per page `noindex`.
- **Social card.** A crop of the hero art, set explicitly on `/` from `public/brand/`. This avoids the root `opengraph-image` file convention, which every route would inherit. The runner up was a generated card with headline text, which needs a committed font and layout code.
- **Robots and sitemap.** Both, minimal, and built from `APP_URL` at request time. A one URL sitemap costs almost nothing and makes the canonical home explicit.
- **No JSON-LD.** No rich result type fits, and Nile's main site carries the organization data.
- **Nothing bookable.** "Reserve" always shows. Checking availability would bring back the database dependency, and `/book` already has its own empty state.
- **No app side rate limit.** The page does no I/O, and Cloudflare absorbs bandwidth abuse.

Settled after the cross check (another model, read only):

- **Rendering.** All three public routes are `force-dynamic`, rather than relying on `connection()` inside `generateMetadata`. Next 16 may not treat metadata alone as making a route dynamic, and it can error when metadata streams on an otherwise static page.
- **Env.** A narrow `appUrl()` helper, so the public pages don't fail when an unrelated auth secret is missing.
- **Footer link.** Always underlined. `primary` against `fg2` is 1.2:1, so color alone fails axe's `link-in-text-block` rule.
- **Metadata tests.** They use DOM locators plus a link preview bot request, because Next streams metadata into the body for ordinary browsers.
- **The no database claim.** It is proven by running `next start` against an unreachable database host, not by an import grep (the frame imports the session module, which connects only when called).
