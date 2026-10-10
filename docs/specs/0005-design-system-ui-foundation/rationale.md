# 0005. Design system and UI foundation: rationale

## Context

The app runs on stock shadcn styling: neutral grays, Geist, a black admin sign in button, and a tracer admin console that is a stack of cards on one page. The owner's mock (`context/reservations_mock.html`) shows the intended product. It embeds a complete "Nile Design System" stylesheet, credited to "Nile Brand Visual Identity Guidelines v1.0, Feb 2026", along with the admin console and the learner flow built on it. The brand rules are strict: Inter is the only typeface, self hosted; CTAs use the Crimson to Amber gradient; secondary colors are for emphasis only.

Eight planned features (admin sections 7 to 10, learner screens 11 to 14) all draw on the same few pieces: a shell with navigation, a searchable table, a form in a modal, a guarded delete, and a toast. Without a shared foundation, each feature would restyle and rebuild them, and the console would drift screen by screen. The scope's done condition asks for `design.md`, keyboard and focus handling in the base pieces, and a shell that matches the mock at desktop and phone widths.

Two forces pull against copying the mock exactly. Several mock color pairs fail WCAG AA: muted text is 4.0:1, white on the CTA gradient's amber end is 2.9:1, the Current pill is 3.6:1, and input borders are 1.3:1. A formal WCAG 2.2 AA audit sits in the scope's Deferred list, so whatever ships now is the baseline it will measure. Separately, the project's shadcn setup is the `base-nova` style (Base UI primitives), not the Radix setup spec 0001 describes, and admin forms already follow one pattern (`useActionState`, a Zod schema in `lib/`, `fieldErrors`) that any modal has to carry.

The stack is settled (spec 0001): Next.js 16 App Router, React 19.2, Tailwind v4, shadcn, lucide icons. Playwright runs locally only, because it needs real Authentik; CI runs lint, format, typecheck and Vitest.

## Options considered

### Option 1: Restyle shadcn through Nile tokens, nudged to AA (chosen)

Map the mock's values onto shadcn's semantic variables and add the Nile brand values as extra Tailwind tokens. Build the shell and shared pieces on shadcn's Sheet, Dialog, AlertDialog, Table and Base UI toast, darken only the failing tints, and guard everything with tests.

**Pros**:
- Every installed and future shadcn component restyles at once; `shadcn add` output fits without rework.
- Accessibility behavior (focus traps, Escape, `aria-current`, live regions) comes from Base UI instead of hand code.
- AA from day one, with the brand still recognisable.

**Cons**:
- Two vocabularies to learn (shadcn names like `primary`, plus Nile names like `nile-ink`).
- The 880px breakpoint is custom, so the shell's nav is hand written rather than shadcn's Sidebar (see the cross check changes below).
- Small, deliberate visual differences from the mock.

### Option 2: Port the mock's CSS as is

Drop shadcn's theme and use the Nile stylesheet's own variable names and the mock's exact values, with components written against them.

**Pros**:
- Closest possible match to the mock; one vocabulary, identical to the brand file.

**Cons**:
- Every shadcn component needs its classes rewritten, and every later `shadcn add` does too.
- Ships the four AA failures into the audit's baseline.
- Focus trapping and dialog semantics have to be written by hand where shadcn parts are bypassed.

### Option 3: Brand lightly, defer the look to each feature

Swap in Inter, the logo and Nile Blue as `--primary`, keep shadcn's stock components, and let each feature match its own screen to the mock.

**Pros**:
- Least work now; nothing speculative is built before a feature needs it.

**Cons**:
- Eight features each solve shell, table, modal and delete again, and they drift apart.
- The scope's done condition (shell matches the mock, base pieces handle focus) is not met.
- No place to state or enforce the color rules.

## Rationale

Option 1 is the only one that meets the scope's done condition without building the same pieces eight times. Features 7 to 10 differ in data, not in shape: each is a header, a searchable table, a form modal and a guarded delete. Fixing those contracts now (`AdminFormState` for the modal, `DeleteCheck` and `DeleteRemove` for deletes) turns those features into data work. Mapping through shadcn's variables rather than replacing them (Option 2) keeps the `base-nova` setup working as designed, so focus and dialog behavior come from Base UI, not from code the team must maintain.

The AA nudge costs little because the failing values are UI tints, not the brand's identity colors. Nile Blue, Ink, Crimson and Amber are untouched as solids, and the darkened `fg3`, pill texts and CTA stops are close to the originals. Doing it now means the deferred audit starts from zero serious findings instead of a known backlog. The one visible change is input borders, a fair trade for controls that low vision users can find.

Tracer Bullet ordering puts the real Testbed Types screen first, through tokens, shell, table, modal and toast. This proves the pieces on real data and the real Server Action before the gallery and the other sections are added. The gallery exists because the delete flow and the blocked dialog have no real delete action until features 7 to 9; it lets `/check verify` and axe exercise them now.

### Sub decisions (the engineer's picks, runner up in brackets)

| Dimension | Pick | Runner up |
|---|---|---|
| Design source | The mock's embedded Nile Design System and admin markup | Official Nile design files added to `context/` |
| Token mapping | Nile values into shadcn variables plus extra Nile tokens | Nile names only |
| Theme | Light only | Follow the system setting |
| Contrast | Nudge failing tints to AA | Match the mock exactly |
| CTA text | Deeper AA gradient stops for text bearing buttons | Nile Ink text on the exact gradient |
| Input border | 3:1 border on inputs only | Soft border with a filled field |
| Font | `next/font/google` Inter | `next/font/local` with the mock's woff2 files |
| Logo | Mock PNGs now, official SVG later | Owner supplied SVGs first |
| Favicon | Shield cropped from the logo | Owner supplied icon |
| Type scale | Small named scale matching the mock | Round to Tailwind steps |
| Sidebar | Hand written nav plus a shadcn Sheet for mobile (changed after the cross check; first pick was shadcn Sidebar restyled) | shadcn Sidebar restyled |
| Breakpoint | 880px, as the mock | Tailwind `md` (768px) |
| Form modal on mobile | One responsive Dialog, anchored to the bottom | Dialog plus Drawer by width |
| Toast | shadcn `toast` (Base UI Toast) | Sonner |
| Search | Browser filter of server rendered rows | URL `?q=` with server filtering |
| Sort and pagination | Neither for now | Clickable column sort |
| Delete flow | Check, then confirm (delete checks again) | Confirm, then maybe blocked |
| Forms | Keep `useActionState` with Zod `fieldErrors` | Add react-hook-form |
| Reach | Admin sign in card plus learner frame | Admin sign in card only |
| Proving | Move the tracer into the shell, plus a dev gallery | Dev gallery only |
| Unbuilt nav items | Show all, with placeholder pages | Hide until built |
| `/admin` root | Redirect to Testbed Types | Redirect to API Keys |
| Mock match proof | Screenshots compared side by side | `toHaveScreenshot` baselines |
| Accessibility tests | axe plus keyboard specs | Keyboard specs only |
| `design.md` | Repo root | `docs/design.md` |
| Errors without a field | Alert in an open modal, toast elsewhere | Toast for all |

### Calls made while writing (pick, why, runner up)

- **Hex, not oklch, for Nile tokens.** The values stay readable against the brand file. (Runner up: convert to oklch like the shadcn default; no visual gain.)
- **Explicit radius tokens** instead of shadcn's multipliers of `--radius`. The mock uses seven fixed radii, and multipliers cannot hit them all. (Runner up: one `--radius` with multipliers.)
- **Toast timing 4s success, 8s error, pause on hover and focus.** The mock's 2.6s is too short to read reliably and fails the spirit of WCAG timing guidance; nothing in a static screenshot shows the difference. (Runner up: keep 2.6s.)
- **Pending saves and deletes cannot be dismissed.** Otherwise a result lands on a closed overlay and the admin never sees an error. (Runner up: allow closing and show the result as a toast.)
- **Cancel focused first in the delete confirm.** A stray Enter should not delete. (Runner up: focus Delete, as many dialogs do.)
- **Each learner page wraps itself in `LearnerFrame`**, with files left where they are. Moving them into a `(learner)` route group would change the action ids in `tests/server-actions-require.test.ts` and three component imports, for no gain over four one line wrappers. (Runner up: the route group; it was the first call and was dropped after the cross check.)
- **`Blocker` moves to `lib/delete-flow.ts`.** Client components need the type, and `server/` modules import `server-only`. (Runner up: a type only import from the server module.)
- **Gallery gated by `isProduction()` in `server/env.ts`.** It keeps the "no `process.env` outside `server/env.ts`" rule. (Runner up: a dedicated `UI_GALLERY_ENABLED` env var; an extra setting for no gain.)
- **Style guard as a Vitest source scan** rather than an ESLint plugin. It runs in CI today with no new dependency, and the rule set is small. (Runner up: an ESLint `no-restricted-syntax` rule over `className` strings, which misses template literals.)
- **Testbed Types and Testbeds tables show only today's columns** (no "Used by", IDP or Clients counts). Those queries belong to features 7 and 9. (Runner up: add the counts now and grow this feature into theirs.)

### Changes after the cross check (2026-10-10)

An independent read on another model found gaps; the engineer chose to apply the recommended fixes.

- **Server to client props.** The first canonical pattern passed render functions (`cell`, `rowLabel`, `children(fields)`) from a Server Component to client components, which Next rejects. DataTable now takes plain rows with cells rendered on the server, and FormDialog takes plain children with errors through a `useFormErrors()` context.
- **Header and body split.** The shell renders no padding; `PageHeader` (full width, holds the mobile menu button) and `PageBody` (the one `<main>`) are separate.
- **Sidebar.** AdminShell is the only user, so a hand written nav plus a Sheet replaces the restyled shadcn Sidebar. Editing its generated code, removing its rail, cookie and shortcut, and moving its breakpoint cost more than the nav itself.
- **Stale lists.** `revalidatePath("/admin")` would miss the new routes; both create actions switch to `revalidatePath("/admin", "layout")`.
- **Tests the move breaks.** Three e2e specs assert the URL ends in `/admin`; they are now listed for update. Dropping the route group keeps the action allow list unchanged.
- **Smaller fixes.** No nested `<main>`. FormDialog internals named. Toast manager named. Contrast test parsing and the `>=` rule named. Style guard scope and palette classes named. Production 404 tested by unit test plus a manual check. Logo extraction and icon sizes named. `currentSession()` cached. A solid 2px focus outline (35% glow alone is under 3:1). Thrown actions handled. Gallery shots for dialogs. Turnstile excluded from axe. A unique e2e suffix.

### Evidence: mock inventory

What the mock's admin view (`context/reservations_mock.html`, view "a") specifies, read from its markup:

- **Sidebar**: fixed, 248px, `--nile-ink`, padding 22px 16px; logo 24px tall with a 1px white 20% divider and "Hands-On Labs" in `--nile-sky` 12.5px semibold; nav buttons 11px 12px padding, 8px radius, 14.5px medium, icon 19px, gap 12px; active `--nile-blue` background and white text, inactive `#AFC6E6`; Sign out under a 1px white 10% top border. Below 880px it slides (`translateX(-272px)`, 220ms) over a `rgba(0,30,45,.45)` scrim.
- **Header**: white, 1px bottom border, padding 20px 28px; title 21px semibold, tracking -0.02em; subtitle 13.5px `--fg3`; mobile menu button 38px, 10px radius, bordered.
- **Primary action**: pill, `--nile-blue`, white bold 14px, padding 11px 20px 11px 16px, `plus` icon 16px.
- **Table card**: white, 16px radius, `--shadow-xs`; search row padding 16px 20px; search pill cloud mist with border, max 320px; headers 11.5px bold uppercase 0.05em `--fg3`; cells 15px 20px padding, 14 to 14.5px; row actions 32px squares, 8px radius, bordered, delete icon `#C42A38`; empty state 60px padding, 14px `--fg3`.
- **Form modal**: overlay `rgba(0,30,45,.5)`; 520px, 20px radius, `--shadow-lg`, max 88vh; header 20px 24px with an 18px title and a close button; body 22px 24px, gap 16px; labels 13px semibold; inputs 1.5px border, 10px radius, 11px 13px padding, 14.5px; footer Cancel and a Save pill. Mobile: full width, anchored to the bottom, radius 20px 20px 0 0.
- **Confirm delete**: 380px, 18px radius, padding 26px; 44px crimson 100 tile with `triangle-alert`; "Delete this?"; message `Delete "<label>"? This can't be undone.`; Delete pill solid `#C42A38`.
- **Blocked dialog**: 400px; 44px nile blue 050 tile with `lock`; per kind title and message; dependents in cloud mist rows, 8px radius, max 160px tall; "Got it" Nile Blue pill. It opens instead of the confirm when dependents exist.
- **Toast**: fixed, bottom 28px, centered, `--nile-ink`, white 14px semibold, padding 14px 22px, pill, `--shadow-lg`, teal `check` icon, 2.6s.
- **Sign in card**: cloud mist page with a `radial-gradient(600px 400px at 50% -10%, --nile-sky-100, transparent)`; card 408px, 24px radius, padding 40px 36px; logo 30px; eyebrow 12px bold uppercase 0.08em Nile Blue; h1 26px semibold; Sign in with SSO pill, 14px padding, bold 15px, `lock` icon.
- **Learner top bar** (view "c"): sticky white bar, padding 16px 28px, 1px bottom border; logo 22px with a divider and "Hands-On Labs" 12.5px semibold `--fg2`; "Sign out" 13.5px semibold `--fg2` with `log-out`.

### Evidence: contrast check of the mock's values

Computed with the WCAG 2 relative luminance formula.

| Pair | Mock ratio | AA adjusted value | New ratio |
|---|---|---|---|
| `fg3` `#6B8295` on white / cloud mist | 4.00 / 3.76 | `#5D7182` | 5.06 / 4.76 (4.50 on `bg-inset`) |
| White on CTA stops `#EC394C` / `#FF6600` | 4.00 / 2.94 | `#E91B31` / `#C95100` | 4.50 / 4.51 |
| Teal 700 `#1E8C66` on teal 100 | 3.62 | `#1A7958` | 4.62 |
| Dawn violet `#8758ED` on violet 100 | 3.65 | `#7641EB` | 4.55 |
| Input border `#DCE3ED` on white | 1.29 | `#7D97B7` | 3.01 |
| Unchanged and passing: white on Nile Blue 7.70, `fg2` on white 6.40, Nile Blue on blue 100 6.23, `#C42A38` on white 5.62, `#AFC6E6` on Ink 9.84, bright blue ring on white 4.70 | | | |
