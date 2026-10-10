# 0005. Design system and UI foundation

**Date**: 2026-10-09
**Status**: Accepted

## Summary

This spec turns the Nile visual language in the mock into the app's design system. The brand colors, Inter, the logo, the radii and the shadows become Tailwind tokens wired into shadcn's theme variables, so every component picks up the Nile look at once. A small set of shared pieces is built on top: the admin shell (sidebar plus mobile drawer), the searchable table, the form modal, the delete confirm, the "in use" dialog, and the toast. The admin sign in card and a learner page frame are included too. A few mock colors are darkened slightly so text and inputs pass WCAG AA (the common accessibility contrast standard). Features 7 to 14 then build their screens from these pieces instead of styling each page by hand.

## Requirements

**User stories**:
- As an admin, I want the console to look and behave like the mock at desktop and phone widths, so that it feels like a Nile product and works on the go.
- As an admin using only a keyboard or a screen reader, I want every menu, dialog and table control to be reachable and announced, so that I can do the job without a mouse.
- As the developer of features 7 to 14, I want ready made shell, table, form modal, delete and toast pieces with fixed contracts, so that each new screen is assembly, not invention.
- As a learner, I want the booking pages to carry the Nile header and colors, so that I trust I'm on the real Nile site.

**Acceptance criteria**:
- **AC-1**: `app/globals.css` is light only (no `.dark` block, no `chart-*` tokens) and maps the Nile palette onto shadcn's variables exactly as in *Token map* below, plus the Nile brand tokens, named text sizes, radii, shadows, gradients and the `nav` breakpoint listed there. The AA adjusted values replace the mock's: `fg3` `#5D7182`, success text `#1A7958`, violet text `#7641EB`, input border `#7D97B7`, and the text bearing CTA gradient `#E91B31` to `#C95100`. A Vitest test reads `app/globals.css`, resolves every pair in the *Contrast pairs* table, and fails when a text pair drops below 4.5:1 or a control boundary pair below 3:1.
- **AC-2**: Inter is loaded with `next/font/google` (`subsets: ["latin"]`, `display: "swap"`, variable weights) as `--font-sans`. Geist and Geist Mono are removed, and the browser makes no request to `fonts.googleapis.com` or `fonts.gstatic.com` (Next fetches the font at build and dev start, so those need network). The color and white Nile logos live in `public/brand/` as PNGs extracted from the mock and render through `next/image` with `alt="Nile"`. They are extracted once by a throwaway script kept outside the repo that decodes the base64 PNG assets from the mock's bundle manifest. `app/icon.png` (512×512) and `app/apple-icon.png` (180×180) are the gradient shield cropped square from the color logo, wordmark excluded, centered on a transparent background (white for the Apple icon). The root metadata has the title template `%s · Nile Hands-On Labs`, the default title `Nile Hands-On Labs`, and no "Create Next App" text.
- **AC-3**: At 880px and wider, every `/admin/*` page renders inside the admin shell: a fixed 248px Nile Ink sidebar holding the white logo, a divider and "Hands-On Labs", then nav links in this order (API Keys `lock`, Testbed Types `layout-grid`, Testbeds `router`, Users `users`), then "Sign out" (`log-out`) pinned to the bottom above a faint divider. The active item is a Nile Blue pill with white text and `aria-current="page"` (Users stays active on `/admin/users/*`). Inactive items are `#AFC6E6`. The white page header runs the full width of the content column (no outer padding) and shows the section title (21px semibold), the subtitle (13.5px, `fg3`) and an optional primary action. Below it the page body sits on cloud mist, max 1180px wide, padded 26px 28px.
- **AC-4**: Below 880px the sidebar is hidden and the header shows a 38px menu button (`aria-label="Open navigation"`, `aria-expanded`). It opens the same nav as a left drawer (a shadcn Sheet, 248px, Nile Ink) over an Ink scrim at 45% opacity. Focus moves into the drawer and stays trapped there. Escape, a click on the scrim, or choosing a link (an `onClick` that closes the Sheet) closes it, and focus returns to the menu button. If the window grows to 880px or wider while the drawer is open, the drawer closes. At 390px wide no page scrolls sideways; a table scrolls sideways inside its own card.
- **AC-5**: `/admin` redirects to `/admin/testbed-types`. `/admin/api-keys` and `/admin/users` show the shell header with the mock's title and subtitle (no action button) and a shadcn Empty state with the section's nav icon, the title "Coming in a later release." and the description "This section is being built." `app/admin/layout.tsx` and every admin page call `requireAdmin()`. A learner or anonymous visitor gets the same refusal as today, and no admin chrome renders for them.
- **AC-6**: The searchable table is a white card (16px radius, `shadow-xs`) with a pill search box (cloud mist fill, input border, search icon, a visually hidden label "Search <section>", the page's placeholder). Typing filters the server rendered rows in the browser. The match is case insensitive on the trimmed query, as a substring of the row's search text (its searchable columns joined by the page), through a pure function in `lib/table-search.ts`. A visually hidden polite live region states the result count after each change ("3 results", "1 result", "No results"). Headers are 11.5px bold uppercase `fg3` with 0.05em tracking. Row action buttons are 32px squares with names such as "Edit Basic" and "Delete Basic". With no rows the card says "No <items> yet. Add one to get started."; with rows but no match, "No <items> match your search."
- **AC-7**: The form modal is one shadcn Dialog. At 880px and wider it is centered, 520px wide, 20px radius. Below 880px it is anchored to the bottom, full width, with 20px top corners and at most 88vh tall (scrolling inside). It has a visible title, a close button named "Close", the form body, and a footer with Cancel (outline pill) and Save (Nile Blue pill). On open, focus goes to the first field. While a save is pending, Save shows a spinner and is disabled, and Cancel, Escape and Close do nothing. It submits through the existing `AdminFormState` contract (`app/admin/actions.ts`): `saved` closes the modal, shows a success toast with the returned message, and the list shows the new row; `error` with `fields` shows each message under its field, keeps every typed value, and moves focus to the first invalid field; `error` with only `message` shows a destructive Alert above the footer and keeps the values. An action that throws (instead of returning a state) unlocks the dialog and shows the Alert "Something went wrong. Try again." Closing the dialog discards the form (it unmounts), and reopening starts empty with no stale errors. On close, focus returns to the button that opened it.
- **AC-8**: The delete flow works as in *Delete flow contract*. Clicking a row's delete button runs the check action (the button shows a spinner meanwhile). Any blockers open the blocked dialog: a lock icon tile, the per kind title and message naming the item, the blocker labels in a list (scrolling past 160px), and one "Got it" button. No blockers opens the confirm dialog: a warning icon tile, "Delete this?", `Delete "<label>"? This can't be undone.`, Cancel (focused first) and a solid danger Delete. Confirming runs the delete action. `ok` closes the dialog, shows the toast "Deleted." and removes the row. `blocked` (someone started using the item in between) swaps to the blocked dialog with the returned list. `failed` closes the dialog and shows an error toast with the message. A check or delete that throws closes the dialog and shows the error toast "Something went wrong. Try again."
- **AC-9**: One toast region is mounted in the root layout and serves admin and learner pages. A success toast is the mock's Ink pill (bottom center, 28px from the bottom, 14px semibold white, teal check) and lasts 4 seconds. An error toast is the same pill with a crimson `circle-alert` icon and a Close button, and lasts 8 seconds. Both pause while hovered or focused and are announced to screen readers. Failures that have no field go to a destructive Alert inside an open form modal, and to an error toast everywhere else.
- **AC-10**: The admin entry page (served at `ADMIN_ENTRY_PATH`) is the mock's sign in card. It is centered on cloud mist with a sky radial glow at the top. The white card is 408px wide with 24px radius and `shadow-lg`. Inside: the color logo (30px tall), the eyebrow "Nile Hands-On Labs · Admin", the heading "Sign in", the subtitle "Testbed & reservation administration", a full width Nile Blue pill button "Sign in with SSO" with a `lock` icon, and the note "Admin access only. Sign in is handled by your identity provider (SSO)." It posts to the existing `signInWithSso` action and keeps `noindex`.
- **AC-11**: `/`, `/book`, `/reservations` and `/auth/error` render inside the learner frame. A sticky white top bar holds the color logo (22px), a divider and "Hands-On Labs" (13px semibold `fg2`), all linking to `/`. On the right is "Sign out" with a `log-out` icon (a form posting the existing `signOut` action), shown only when a session exists. Tab order in the bar: skip link, logo link, Sign out. The body is cloud mist. Each page wraps its content in `LearnerFrame` itself (the routes stay where they are). Each page's own content is unchanged (features 11 to 14 restyle it), except that its own `<main>` becomes a `<div>` (the frame owns the one `<main>`) and the raw `bg-black`, `dark:` and `zinc` classes in `/reservations` and `/auth/error` become `Button` and token classes. No learner page links to the admin entry path.
- **AC-12**: `/admin/testbed-types` and `/admin/testbeds` replace the tracer console. Each has the shell header ("Testbed Types" or "Testbeds" with the mock subtitle) and an "Add type" or "Add testbed" button (`plus` icon) that opens the form modal holding today's create form and action. Each lists its rows in the searchable table: types show Type and Duration; testbeds show Name, Testbed type, and Access group (`pod-<slug>`, or a `neutral` badge reading "Not ready"). There is no Actions column until features 7 and 9. The testbeds page also loads `listTestbedTypes` for the form's type select. Both create actions call `revalidatePath("/admin", "layout")` (today `revalidatePath("/admin")`, which would miss the new routes), so a saved row appears without a reload. Spec 0004 AC-1 and AC-2 still hold: same inputs, same field labels ("Name", "Duration", "Unit", "Type", "Nile Portal URL", "LMS URL"), same messages, same group saga; only the submit button is now the modal's "Save".
- **AC-13**: `/admin/ui-gallery` (admin only, and a 404 when `isProduction()` is true) shows every base piece with sample data. It includes each Button variant and size, each Badge tone, the inputs, the searchable table in its filled, empty and no match states, and a form modal whose fake action can return field errors, a message error, or saved. It also has delete flows whose fake check and delete return each outcome (blocked, ok, blocked after confirm, failed), and buttons that fire a success and an error toast. The fakes are browser functions, not Server Actions. Its header reads "UI Gallery" with the subtitle "Every base piece with sample data. Not available in production." It is not in the nav.
- **AC-14**: The admin layout and the learner frame start with a "Skip to content" link, the first thing Tab reaches, which jumps to `<main id="content">`. Every interactive element shows a focus indicator on `:focus-visible`: a solid 2px `ring` outline with a 2px offset (4.7:1 on white), with the mock's soft 3px glow (`ring` at 35%) allowed outside it; on Ink the outline uses `sidebar-ring`. Every icon only button has an accessible name. With `prefers-reduced-motion: reduce`, the drawer, dialog and toast transitions are off. `@axe-core/playwright` finds no serious or critical violation on: the shell at 1280px and at 390px with the drawer open, the sign in card, `/book` (with the Turnstile iframe excluded, as third party content), and the gallery with the form modal, confirm dialog and blocked dialog each open.
- **AC-15**: A Playwright spec captures screenshots at 1280×800 and 390×844 of: the shell on Testbed Types, the mobile drawer open, the form modal, the confirm dialog, the blocked dialog, a toast, the sign in card, and `/book` in the learner frame. The dialog and toast shots come from the gallery, so they do not depend on data in the shared database. `/check verify` compares them with the mock at the same widths and records the call in `verify.md`. Only the differences listed in *Allowed differences from the mock* are accepted.
- **AC-16**: A root `design.md` documents the tokens (name, value, use), the AA adjustments with their ratios, the type scale, the radii, shadows and motion, the component inventory with each contract and when to use it, the error display rule, and the rules in *Standard definition*. It links this spec for the reasons.

## Decision

**Chosen option**: Option 1: restyle shadcn (Base UI) through Nile tokens taken from the mock, nudged to WCAG AA, with shared admin pieces under fixed contracts.

The mock's embedded Nile Design System is the source of truth. Its values feed shadcn's semantic variables and extra Tailwind tokens in `app/globals.css`. The shell (a plain nav, with a shadcn Sheet as the mobile drawer), table, form modal, delete flow and toast are built once on shadcn's Sheet, Dialog, AlertDialog, Table and Base UI toast, and are guarded by a contrast test, a style guard test, and axe in Playwright.

**Implementation skills**: `shadcn` (`shadcn-ui/ui`, `.claude/skills/shadcn/`) · `tailwind-design-system` (`wshobson/agents`, `.claude/skills/tailwind-design-system/`) · `vercel-react-best-practices` (`vercel-labs/agent-skills`, `.claude/skills/vercel-react-best-practices/`) · `vitest` (`antfu/skills`, `.claude/skills/vitest/`) · `playwright-best-practices` (`currents-dev/playwright-best-practices-skill`, `.claude/skills/playwright-best-practices/`) · `playwright-cli` (`microsoft/playwright-cli`, `.claude/skills/playwright-cli/`)

## Rationale

Reasoning and options: see [rationale.md](rationale.md).

## Feature design

### Data model sketch

None. This feature touches no schema and no migration.

### Token map

Hex values stay hex (shadcn reads any CSS color), so they can be checked against the brand file by eye.

| shadcn variable | Nile value | Mock name |
|---|---|---|
| `--background` | `#F6F8FB` | cloud mist (page) |
| `--foreground`, `--card-foreground`, `--popover-foreground`, `--secondary-foreground` | `#001E2D` | nile ink, `fg1` |
| `--card`, `--popover` | `#FFFFFF` | white |
| `--primary` / `--primary-foreground` | `#0E4EAF` / `#FFFFFF` | nile blue |
| `--secondary`, `--muted` | `#EEF2F8` | `bg-inset` |
| `--muted-foreground` | `#4D626C` | nile slate, `fg2` |
| `--accent` / `--accent-foreground` | `#EEF4FE` / `#0E4EAF` | nile blue 050 (hover tint) |
| `--destructive` | `#C42A38` | the mock's delete red (named `danger-strong`) |
| `--border` | `#DCE3ED` | `border` (cards, tables, dividers) |
| `--input` | `#7D97B7` | AA adjusted control border |
| `--ring` | `#2070E1` | bright nile blue (used at 35%) |
| `--radius` | `0.625rem` | 10px (inputs); the `--radius-*` steps below replace shadcn's `calc(var(--radius) * n)` multipliers with literal px |
| `--sidebar` / `--sidebar-foreground` (used by AdminShell's own nav, not a shadcn Sidebar) | `#001E2D` / `#AFC6E6` | ink / `fg-on-dark-2` |
| `--sidebar-primary` / `--sidebar-primary-foreground` | `#0E4EAF` / `#FFFFFF` | active nav pill |
| `--sidebar-accent` / `--sidebar-accent-foreground` | `#072F68` / `#FFFFFF` | deep nile blue (hover) |
| `--sidebar-border` | `rgb(255 255 255 / 0.1)` | |
| `--sidebar-ring` | `#8BB4EE` | nile sky (focus on Ink, 8.1:1) |

Extra tokens in `@theme`:
- **Colors** (`bg-*`, `text-*`): `nile-blue`, `nile-blue-700` `#0A3C87`, `nile-blue-100` `#DCE8FB`, `nile-blue-050`, `deep-nile-blue`, `bright-nile-blue`, `nile-ink`, `nile-slate`, `nile-sky`, `nile-sky-100` `#CBDEFA`, `solar-amber` `#FF6600`, `amber-100` `#FFE7D4`, `solar-crimson` `#EE4A59`, `crimson-100` `#FCE0E3`, `nile-teal` `#35D39A`, `teal-100` `#D6F5E9`, `dawn-violet` `#8758ED`, `violet-100` `#ECE3FC`, `cloud-mist`, `bg-inset`, `fg1`, `fg2`, `fg3` `#5D7182`, `border-strong` `#C2CEDD`, `success-fg` `#1A7958`, `violet-fg` `#7641EB`, `danger-strong` `#C42A38`.
- **Text sizes**: `text-th` 11.5px, `text-pill` 12.5px, `text-sub` 13.5px, `text-cell` 14.5px, `text-title` 21px, `text-card-title` 26px. Tailwind's own steps cover the rest (`text-xs` 12, `text-sm` 14, `text-base` 16, `text-lg` 18).
- **Radii**: `rounded-sm` 8px (icon buttons, nav items), `rounded-md` 10px (inputs), `rounded-lg` 12px (icon tiles), `rounded-xl` 16px (cards), `rounded-2xl` 18px (alert dialogs), `rounded-3xl` 20px (form modal), `rounded-4xl` 24px (sign in card), `rounded-full` (pills).
- **Shadows**: `shadow-xs`, `shadow-sm`, `shadow-md`, `shadow-lg`, `shadow-cta`, `shadow-blue` with the mock's values.
- **Gradients** (as `@utility`): `bg-nile-cta` (AA, `#E91B31` to `#C95100` at 135°, for any button with text), `bg-nile-cta-brand` (exact `#EC394C` to `#FF6600`, decoration only), `bg-nile-mark` (`#FF6600` to `#EE4A59` at 135°, avatars and the shield), `bg-nile-brand` (dividers).
- **Motion**: `--ease-nile: cubic-bezier(.2,.7,.3,1)`; 120, 200 and 360ms durations.
- **Breakpoint**: `--breakpoint-nav: 55rem` (880px), which gives the `nav:` variant.

### Contrast pairs

The AC-1 test checks exactly these pairs, foreground on background. It reads `--color-*` values from the `@theme` block, the shadcn variables from `:root` (skipping any that are a `var()` alias), and the two `bg-nile-cta` stops from the `@utility bg-nile-cta` block, and compares unrounded ratios with `>=` (three pairs sit right at the limit, so a one digit drift in a hex value fails). `#AFC6E6` is read as `--sidebar-foreground`.

| Pair | Minimum | Ratio |
|---|---|---|
| `fg1` on white, cloud mist | 4.5 | 16.1+ |
| `fg2` on white, cloud mist, `bg-inset` | 4.5 | 5.7+ |
| `fg3` on white, cloud mist, `bg-inset` | 4.5 | 4.5+ |
| white on `nile-blue` | 4.5 | 7.7 |
| white on `danger-strong` | 4.5 | 5.6 |
| white on both `bg-nile-cta` stops | 4.5 | 4.5+ |
| `nile-blue` on `nile-blue-100` (Upcoming, IDP) | 4.5 | 6.2 |
| `success-fg` on `teal-100` (Current, Active) | 4.5 | 4.6 |
| `violet-fg` on `violet-100` (AI) | 4.5 | 4.55 |
| `fg2` on `bg-inset` (Past, Inactive) | 4.5 | 5.7 |
| `#AFC6E6` on `nile-ink` (nav) | 4.5 | 9.8 |
| `--input` on white (control boundary) | 3.0 | 3.0 |
| `--ring` on white (focus indicator) | 3.0 | 4.7 |

### Component inventory

| Piece | File | Built on | Notes |
|---|---|---|---|
| Button | `components/ui/button.tsx` (edited) | shadcn Button | Variants `default` (Nile Blue pill, bold 14px, hover `nile-blue-700`), `cta` (`bg-nile-cta`, `shadow-cta`, bold 15px), `outline` (white, 1.5px `border-strong`, semibold), `ghost`, `destructive` (solid `danger-strong`), `link`. Sizes `default` 40px, `lg` 48px, `icon` 32px square with 8px radius. Pending state: shadcn `Spinner` with `data-icon` plus `disabled`. |
| Badge | `components/ui/badge.tsx` (add) | shadcn Badge | Tones `info`, `success`, `neutral`, `accent` from *Contrast pairs*; pill, `text-pill`, semibold. Status words map to tones in `lib/badge-tones.ts`. |
| Input, Select, Label, Field, Alert, Card, Empty, Separator, Skeleton, Spinner | `components/ui/` (restyle or add) | shadcn | Inputs: 1.5px `--input` border, 10px radius, 14.5px text, 11px 13px padding. Field supplies label, description and error layout (replaces `components/form-field.tsx`) and sets `data-field=<dotted path>` on its control. |
| Sheet | `components/ui/sheet.tsx` (add) | shadcn (Base UI Dialog) | The mobile nav drawer only. No shadcn Sidebar, no Tooltip. |
| Dialog, AlertDialog, Table | `components/ui/` (add) | shadcn (Base UI) | Overlay `nile-ink` at 50%. |
| Toast | `components/ui/toast.tsx` (add) | shadcn `toast` (Base UI Toast) | A module constant `toastManager = Toast.createToastManager()` in `components/notify.ts` (an allowed lazy singleton, like the other module caches) is passed to the provider in `app/layout.tsx`. `notifySuccess(message)` adds `{ timeout: 4000, priority: "low" }`; `notifyError(message)` adds `{ timeout: 8000, priority: "high" }` (assertive) with a Close button. If the `base-nova` registry has no `toast` item, write `components/ui/toast.tsx` by hand over `@base-ui/react/toast`. |
| AdminShell | `components/admin/admin-shell.tsx` (client) | `<nav>` plus Sheet | Desktop: a fixed `<aside>` shown from `nav:` up. Mobile: the same nav list inside the Sheet, opened from PageHeader through a small context (`useAdminNav()` with `open`, `setOpen`); a `matchMedia("(min-width: 55rem)")` listener closes it. Reads `ADMIN_NAV` and `usePathname()`; each link sets `aria-current` and closes the Sheet on click. Sign out is a form posting the existing `signOut` action. Renders no padding around its children. |
| PageHeader | `components/admin/page-header.tsx` (client) | | Props `section: AdminSection` (or an explicit `title` and `subtitle` for the gallery) and `action?: ReactNode`. Title and subtitle come from `ADMIN_NAV`. Holds the mobile menu button. Full width, white, bottom border, padding 20px 28px. |
| PageBody | `components/admin/page-body.tsx` | | `<main id="content">`, cloud mist, max 1180px centered, padding 26px 28px 60px, 20px gaps. |
| DataTable | `components/admin/data-table.tsx` (client) | shadcn Table | Props are plain data only (a Server Component builds them): `columns: readonly { key: string; header: string; align?: "left" \| "right" }[]`, `rows: readonly { id: string; label: string; search: string; cells: Readonly<Record<string, ReactNode>>; actions?: ReactNode }[]`, `searchPlaceholder`, `noun: { one, many }`. `search` is the row's searchable text (the page joins the searchable columns); `cells` are already rendered on the server. An Actions column appears only when some row has `actions`. |
| FormDialog | `components/admin/form-dialog.tsx` (client) | Dialog | Props: `trigger: ReactElement` (passed through Base UI's `render` prop), `title`, `action: (prev: AdminFormState, form: FormData) => Promise<AdminFormState>`, `children: ReactNode`. Provides `useFormErrors()` (a context with `fields` and `message`) that field components read. Internals: submits from `onSubmit` with `startTransition` (so React does not reset fields on an error); detects a new `saved` state by identity in render (the `useFormKey` pattern) to close and toast; the form unmounts on close, so reopening is empty and the action state starts idle; after an error, focuses `form.querySelector('[aria-invalid="true"]')`; `onOpenChange` ignores close requests while pending; wraps the action call in try/catch for thrown errors. |
| DeleteFlow | `components/admin/delete-flow.tsx` (client) | AlertDialog, Dialog | Props: `kind: DeleteKind`, `id`, `label`, `check`, `remove` (Server Actions passed from the page; see *Delete flow contract*). |
| LearnerFrame | `components/learner-frame.tsx` (server) | | Top bar plus `<main id="content">`; calls `currentSession()` for the Sign out link. |
| SkipLink | `components/skip-link.tsx` | | AC-14. |

Field components for the existing forms become fields only (`components/admin/testbed-type-fields.tsx`, `components/admin/testbed-fields.tsx`, the latter keeping its client rows), with no submit button and no `FormStatus`. `components/admin/use-form-key.ts` and `FormStatus` are deleted.

### API surface

No new Server Actions or routes with side effects. New and changed routes:

| Route | Kind | Auth | Notes |
|---|---|---|---|
| `/admin` | page | admin | `redirect("/admin/testbed-types")` |
| `/admin/testbed-types` | page | admin | AC-12; uses `createTestbedTypeAction` |
| `/admin/testbeds` | page | admin | AC-12; uses `createTestbedAction` |
| `/admin/api-keys`, `/admin/users` | page | admin | AC-5 placeholders |
| `/admin/ui-gallery` | page | admin; 404 in production | AC-13 |
| `app/admin/layout.tsx` | layout | admin | `requireAdmin()` plus AdminShell; no padding |
| `/`, `/book`, `/reservations`, `/auth/error` | page | public | each wraps its content in LearnerFrame; files stay where they are, so imports and the action allow list are unchanged |
| `/auth/landing`, `/reservations` admin redirect | route, page | | keep redirecting admins to `/admin`, which forwards to `/admin/testbed-types` |

Existing tests this changes: `e2e/sign-in.spec.ts`, `e2e/isolation.spec.ts` and `e2e/booking.spec.ts` assert `toHaveURL(/\/admin$/)` after admin sign in and become `/\/admin\/testbed-types$/`. `e2e/booking.spec.ts` also opens the "Add type" and "Add testbed" modals and clicks "Save" instead of "Create type". `tests/server-actions-require.test.ts` needs no change.

### Delete flow contract

Shared by features 7 to 10. Types live in `lib/delete-flow.ts` (safe on both sides); `Blocker` moves there from `server/db/delete-blockers.ts`, which then imports it.

```ts
export type DeleteKind = "api_key" | "testbed_type" | "testbed";
export type Blocker = { readonly id: string; readonly label: string };

// check: run on click. Ok with [] means "safe to confirm".
export type DeleteCheck = (id: string) => Promise<Result<readonly Blocker[], "unavailable">>;

// remove: locks, checks again, deletes, all in one transaction (spec 0002 AC-14).
export type DeleteRemove = (id: string) => Promise<
  Result<void, { readonly kind: "blocked"; readonly blockers: readonly Blocker[] }
             | { readonly kind: "failed"; readonly message: string }>
>;
```

Copy per kind (`lib/delete-flow.ts`, from the mock; `<label>` is the row's name):

| Kind | Blocked title | Blocked message |
|---|---|---|
| `api_key` | API key in use | "<label>" is assigned to the testbeds below. Remove it from them first. |
| `testbed_type` | Testbed type in use | "<label>" is assigned to the testbeds below. Reassign or delete them first. |
| `testbed` | Testbed has active reservations | "<label>" has upcoming or current reservations below. Resolve them first. |

A `check` that returns `err("unavailable")` shows the error toast "Couldn't check whether this can be deleted. Try again." A `check` or `remove` that throws shows "Something went wrong. Try again." Both actions call `requireAdmin()` like every admin action.

### Value sourcing

| Action / screen | Value | Source |
|---|---|---|
| Admin shell | nav items, order, icons, section titles and subtitles | `ADMIN_NAV` constant in `lib/admin-nav.ts`, copied from the mock (API Keys: "Credentials used to connect testbeds to identity providers and AI services."; Testbed Types: "Lab difficulty levels and how long each reservation lasts."; Testbeds: "The remote labs customers can reserve."; Users: "Everyone with hands-on lab access.") |
| Admin shell | active item | `usePathname()` matched by prefix against `ADMIN_NAV[].href` |
| Admin shell | mobile or desktop | CSS `nav:` variant for layout; `matchMedia("(min-width: 55rem)")` only to close an open Sheet |
| Gallery header | title, subtitle | fixed strings in AC-13 (the gallery is not in `ADMIN_NAV`) |
| Placeholder pages | icon, empty text | the section's `ADMIN_NAV` icon; the AC-5 strings |
| DataTable | rows (`id`, `label`, `cells`) | built by the page from its existing server query (`listTestbedTypes`, `listTestbeds`); `label` is the row name |
| DataTable | `search` text | the page joins the searchable columns. Types: name and duration text; testbeds: name, type name, access group text |
| DataTable | placeholder, nouns | page props. Types: "Search testbed types…"; testbeds: "Search by name, type, or access group…" |
| Testbeds form | type options | `listTestbedTypes` on the testbeds page |
| DataTable | result count text | derived from the filtered row count |
| FormDialog | success toast text | `AdminFormState.message` from the action (today `Created <name>.`) |
| FormDialog | field errors, form error | `AdminFormState.fields` / `.message`, handed to fields through `useFormErrors()` |
| FormDialog | first invalid field | the first element with `aria-invalid="true"` in DOM order (Field marks it, keyed by dotted path such as `clients.0.url`) |
| DeleteFlow | blockers | `DeleteCheck` / `DeleteRemove` result (`server/db/delete-blockers.ts` labels: testbed name, or learner name) |
| DeleteFlow | dialog copy | per kind table above plus the row's `label` |
| Learner frame | Sign out visible | `currentSession()` from `server/auth/require.ts` is defined |
| Gallery | available | `isProduction()`, a new reader in `server/env.ts` that parses `NODE_ENV` with Zod (the only place it is read) |
| Brand | logo files | `public/brand/nile-logo.png`, `public/brand/nile-logo-white.png` (extracted from `context/reservations_mock.html`) |

### Key invariants

- Components never use a raw hex, `rgb()` or arbitrary color value; colors come from tokens only. Outside `components/ui/`, no `dark:` classes.
- One toast region, one Dialog per open overlay. The delete confirm never opens when a check returned blockers.
- A save or delete in flight cannot be dismissed, so its result never lands on a closed overlay.
- Learner pages never link to the admin entry path (spec 0003 AC-3).
- `NODE_ENV` is read only in `server/env.ts`.
- Each page has exactly one `<main id="content">` (PageBody in admin, LearnerFrame for learners).
- Server Components pass only serializable props (data, rendered nodes, Server Actions) to client components; never a plain function.

### Security model

- Admin routes: `requireAdmin()` in `app/admin/layout.tsx` and again in every admin page (a layout alone does not run again on client navigation). `currentSession()` is wrapped in React `cache()`, so the layout and the page share one session read per request. The gallery is admin only and returns 404 in production.
- LearnerFrame reads the session, so `/` and `/auth/error` render per request instead of statically. Accepted: the cost is one cached session read.
- No new Server Action. The gallery's fakes run in the browser, so `tests/server-actions-require.test.ts` needs no change.
- Fonts and logos are served from the app's own origin; no third party request at runtime.
- No PII in this feature beyond what pages already show.

### Configuration required

No new env vars. `isProduction()` reads `NODE_ENV`, which Next sets itself. New dev dependency: `@axe-core/playwright`.

### Allowed differences from the mock

- The AA adjusted colors in AC-1 (most visible: darker input borders and the deeper CTA gradient).
- Copy without dashes ("No testbed types yet. Add one to get started.") and without the mock's "This screen is a mock" note.
- Toast timing: 4s and 8s instead of 2.6s.
- Columns and buttons for features not built yet are absent (AC-5, AC-12).

### Critical test scenarios

All new Vitest tests are pure (Vitest runs in the node environment, with no jsdom); component behavior is tested in Playwright.

- Token contrast: the Vitest pair test (parsing rules in *Contrast pairs*) passes on the committed CSS and fails when `fg3` is set back to `#6B8295`. Verifies **AC-1**.
- Style guard: a Vitest test scans `.ts`/`.tsx` files under `app/` and `components/` (excluding `components/ui/`; `app/globals.css` is not scanned) for raw hex, `rgb(`, `bg-[#`, `text-[#`, `dark:`, and Tailwind's raw palette classes (`(text|bg|border|ring)-(black|white|zinc|gray|slate|neutral|stone)`), and fails on any hit. Verifies **AC-1**, *Key invariants*.
- Search matcher: plain input/output tests for `lib/table-search.ts` (case, trim, empty query, no match). Verifies **AC-6**.
- `isProduction()`: a unit test for its parsing (`production` true, `development` and `test` false, missing value false). The production 404 itself is checked by hand in `/check verify` with a production build. Verifies **AC-13**.
- Form modal: in the gallery, a fake action returning field errors keeps the values and focuses the first invalid field; a message error shows the Alert; saved closes the modal and toasts. Playwright. Verifies **AC-7**, **AC-9**.
- Delete flow: each fake outcome opens the right dialog; "blocked after confirm" swaps to the blocked dialog. Playwright. Verifies **AC-8**.
- Real thread: as `hol-test-admin`, add an `e2e <unique suffix>` testbed type through the modal on `/admin/testbed-types`; the toast reads `Created <name>.` and the row appears and is found by search. The row stays in the shared database (there is no delete until feature 7); the suffix keeps runs apart. Verifies **AC-7**, **AC-12**.
- Keyboard: Tab from page load reaches the skip link first; at 390px the drawer traps focus, Escape closes it, and focus returns to the menu button; Escape on a pending save does nothing. Verifies **AC-4**, **AC-7**, **AC-14**.
- Axe: no serious or critical issue on the AC-14 page list. Verifies **AC-14**.
- Auth: a learner session opening `/admin/testbeds` or `/admin/ui-gallery` gets today's refusal with no shell. Verifies **AC-5**, **AC-13**.
- Thrown errors: a gallery fake that throws unlocks the form modal with the generic Alert, and a throwing delete shows the generic error toast. Verifies **AC-7**, **AC-8**.
- No font CDN: the Playwright network log for `/book` has no request to Google font hosts. Verifies **AC-2**.

## Standard definition

**Canonical pattern** (an admin section page in features 7 to 10):

```tsx
// app/admin/testbed-types/page.tsx (a Server Component: only data,
// rendered nodes and Server Actions cross into the client pieces)
export default async function TestbedTypesPage() {
  await requireAdmin();
  const types = await listTestbedTypes(db());
  const rows = types.map((t) => {
    const duration = formatDuration(t);
    return {
      id: t.id,
      label: t.name,
      search: `${t.name} ${duration}`,
      cells: { name: <span className="font-semibold text-fg1">{t.name}</span>, duration },
    };
  });
  return (
    <>
      <PageHeader
        section="testbed-types"
        action={
          <FormDialog
            trigger={<Button><PlusIcon data-icon="inline-start" />Add type</Button>}
            title="Add testbed type"
            action={createTestbedTypeAction}
          >
            <TestbedTypeFields />
          </FormDialog>
        }
      />
      <PageBody>
        <DataTable
          columns={[
            { key: "name", header: "Type" },
            { key: "duration", header: "Duration" },
          ]}
          rows={rows}
          noun={{ one: "testbed type", many: "testbed types" }}
          searchPlaceholder="Search testbed types…"
        />
      </PageBody>
    </>
  );
}

// components/admin/testbed-type-fields.tsx ("use client")
export function TestbedTypeFields() {
  const { fields } = useFormErrors();
  return <Field path="name" label="Name" error={fields.name}>{/* Input */}</Field>;
}
```

Features 7 to 10 add row actions as rendered nodes, for example `actions: <DeleteFlow kind="testbed_type" id={t.id} label={t.name} check={checkTestbedTypeDelete} remove={deleteTestbedType} />`.

**Replaces**:
- Per page `<main>` wrappers, `Card` stacks and hand drawn `<table>`s in admin pages.
- `FormStatus` lines for success; success is a toast, and a non field failure is an Alert in the modal.
- `components/form-field.tsx`, replaced by shadcn Field; `use-form-key.ts`, replaced by FormDialog's open state.
- Render function props from Server Components (`cell: (row) => …`, `children(fields)`).
- Raw colors, raw palette classes (`zinc`, `black`, `gray`…) and scaffold leftovers (`bg-black`, `dark:bg-white`, `.dark` tokens, Geist, the Next.js `public/*.svg` files).

**Enforcement**:
- The Vitest style guard and contrast tests (run in CI with `npm test`).
- `@axe-core/playwright` and keyboard specs (run locally with `npm run test:e2e`; Playwright needs real Authentik, so it stays out of CI).
- `design.md` as the reference that `/develop` reads for any UI work.

**Rollout**: one migration in this feature for the admin console, the admin sign in card, and the learner frame. The contents of the learner pages move to the standard in features 11 to 14, when each is rebuilt.

**Exceptions**:
- `components/ui/` (shadcn generated code) may keep its own `dark:` classes and internal values.
- Email templates (feature 15) use inline styles, because mail clients ignore CSS variables; they copy hex values from `design.md` by hand.

## Build plan

Tracer Bullet: first one real admin screen runs through the new tokens, shell, table, modal and toast, then the thread thickens.

1. [x] Tokens and brand: rewrite `app/globals.css` per *Token map* (light only, AA values, `@theme` tokens, gradient utilities, `nav` breakpoint); switch to Inter through `next/font/google`; set the root metadata template; extract the logos to `public/brand/` and crop `app/icon.png` and `app/apple-icon.png`; delete Geist and the scaffold SVGs; add the contrast and style guard Vitest tests, satisfies **AC-1**, **AC-2**
2. [x] Thread through the shell on Testbed Types: first confirm the `base-nova` registry has `sheet`, `dialog`, `alert-dialog`, `alert`, `field`, `badge`, `table`, `empty`, `spinner`, `skeleton`, `separator` and `toast` (write `toast` by hand over `@base-ui/react/toast` if missing), then add them; restyle `button`, `input`, `select`, `label`, `card`; build `lib/admin-nav.ts`, AdminShell (nav plus Sheet), PageHeader, PageBody, SkipLink, `app/admin/layout.tsx`, the toast manager and provider, DataTable with `lib/table-search.ts` (and its tests), Field with `useFormErrors()`, and FormDialog; wrap `currentSession()` in `cache()`; turn the type form into `TestbedTypeFields` inside `/admin/testbed-types`; switch both create actions to `revalidatePath("/admin", "layout")`; redirect `/admin`; update the `/admin$` URL asserts in the three e2e specs, satisfies **AC-3**, **AC-4**, **AC-5**, **AC-6**, **AC-7**, **AC-9**, **AC-12**, **AC-14**
3. [x] Thicken the console: `/admin/testbeds` with `TestbedFields` (client rows) in the form modal and the type list loaded for its select, the API Keys and Users placeholders, delete `use-form-key.ts`, `FormStatus` and `form-field.tsx`, and update `e2e/booking.spec.ts` to the modals and "Save", satisfies **AC-5**, **AC-12**
4. [x] Delete flow and gallery: `lib/delete-flow.ts` (types, copy, `Blocker` moved), DeleteFlow with the confirm and blocked dialogs and thrown error handling, the error toast, `isProduction()` in `server/env.ts` (and its unit test), and `/admin/ui-gallery` with browser fakes (including ones that throw), satisfies **AC-8**, **AC-9**, **AC-13**
5. [x] Sign in card and learner frame: restyle the admin entry page; build LearnerFrame (with its Sign out form) and wrap `/`, `/book`, `/reservations` and `/auth/error` in it where they are; turn each page's own `<main>` into a `<div>`; replace the raw `bg-black`, `dark:` and `zinc` classes in `/reservations` and `/auth/error` with `Button` and tokens, satisfies **AC-10**, **AC-11**, **AC-14**
6. [x] Proof and reference: add `@axe-core/playwright`; write the axe and keyboard specs and the screenshot spec at 1280 and 390; write the root `design.md`, satisfies **AC-14**, **AC-15**, **AC-16**

## Consequences

**Positive**:
- Every later screen is assembled from fixed pieces with fixed contracts (`AdminFormState`, `DeleteCheck`/`DeleteRemove`), so features 7 to 10 become mostly data work.
- Brand, contrast and the no raw colors rule are checked automatically, so drift fails a test rather than a review.
- The later WCAG 2.2 AA audit starts from an axe baseline with no serious issues.

**Negative / tradeoffs**:
- Forms look a little crisper than the mock (input border `#7D97B7`), and the learner CTA gradient is deeper than the brand file. Both are deliberate and listed in `design.md`.
- AdminShell's nav is hand written (about 60 lines), so active state and mobile closing are the project's own code rather than shadcn Sidebar's.
- Pages build table cells on the server and pass rendered nodes, so per row interactivity beyond the actions slot needs its own client component.
- The learner frame reads the session, so `/` and `/auth/error` render per request.
- Client side search sends every row to the browser and there is no sorting or pagination; a list past about 200 rows needs a revisit.
- "Matches the mock" rests on a human comparing screenshots, not on pixel baselines.
- PNG logos blur at high zoom until the owner supplies SVGs.
- Light only: a dark mode later means designing a second palette and checking it again.

**Neutral**:
- Three e2e specs change their post sign in URL assert, and `e2e/booking.spec.ts` drives the new modals.
- `Blocker` moves to `lib/delete-flow.ts`; `server/db/delete-blockers.ts` imports it from there.
- One new dev dependency (`@axe-core/playwright`), no new runtime dependency.

## Follow-up

- [ ] Spec 0001 drift: its UI row says "shadcn/ui (Radix primitives)" and its Forms row says "react-hook-form + shadcn Form". The code uses the `base-nova` style (Base UI) and `useActionState` with Zod `fieldErrors`, which this spec standardizes. Update spec 0001 in place.
- [ ] Owner: provide official Nile logo SVGs (color, white) and, if one exists, an official favicon, to replace the PNG extracts in `public/brand/` and `app/icon.png`.
- [ ] `/sync`: add a root `AGENTS.md` pointer to `design.md` and the UI rules (tokens only, FormDialog and DeleteFlow contracts, error display rule). Record under `Declined:` that the Agent Skill search for `@axe-core/playwright` was declined (the installed `playwright-best-practices` covers it).
- [ ] Revisit search, sorting and pagination when an admin list passes about 200 rows (Users is the likely first).
- [ ] Feature 11: extract the hero image (1920×1080 JPEG) from the mock when the landing page is built.
- [ ] Feature 15: email templates copy the Nile hex values from `design.md`, since mail clients ignore CSS variables.
