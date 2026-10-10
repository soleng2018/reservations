# Nile HOL design system

source: image (the Nile Design System embedded in `context/reservations_mock.html`)
tokens: `app/globals.css` (the source of truth; this file mirrors it for reading)
decision and reasons: [spec 0005](docs/specs/0005-design-system-ui-foundation/index.md)

## Character

Calm, confident, and clear. White cards and a cloud mist page, Nile Blue for
the one action that matters, and the Ink sidebar as the anchor of the admin
console. Rounded geometry everywhere: pill buttons and badges, 16px cards,
20px modals. One typeface, Inter, with semibold headings, regular body text,
and bold button labels. Color is used sparingly: the brand orange and crimson
appear in the logo shield and the learner call to action, never as UI chrome.
Light only.

## Build mandate

- Build every screen from the pieces below. A new screen is assembly, not
  invention: PageHeader plus PageBody plus DataTable plus FormDialog covers
  an admin section.
- Colors come from tokens only. No raw hex, `rgb()`, `bg-[#…]`, `dark:`, or
  Tailwind's raw palette (`zinc`, `gray`, `black`, `white`…) outside
  `components/ui/`. The style guard test enforces it.
- Every text pair meets WCAG AA (4.5:1), every control boundary and focus
  indicator 3:1. Add a new pair to the contrast test when you add a token.
- Match the mock. The only accepted differences are listed under *Allowed
  differences* below.

## Tokens

Use them as Tailwind classes: `bg-nile-blue`, `text-fg3`, `border-input`.

### shadcn variables (`:root`)

| Variable | Value | Use |
|---|---|---|
| `--background` | `#F6F8FB` | the page (cloud mist) |
| `--foreground`, `--card-foreground`, `--popover-foreground`, `--secondary-foreground` | `#001E2D` | body text (nile ink) |
| `--card`, `--popover` | `#FFFFFF` | cards, dialogs, menus |
| `--primary` / `--primary-foreground` | `#0E4EAF` / `#FFFFFF` | the main action |
| `--secondary`, `--muted` | `#EEF2F8` | inset fills |
| `--muted-foreground` | `#4D626C` | secondary text (nile slate) |
| `--accent` / `--accent-foreground` | `#EEF4FE` / `#0E4EAF` | hover tint |
| `--destructive` | `#C42A38` | delete, errors |
| `--border` | `#DCE3ED` | cards, tables, dividers |
| `--input` | `#7D97B7` | form control borders (AA adjusted) |
| `--ring` | `#2070E1` | focus indicator |
| `--radius` | `0.625rem` | 10px, inputs |
| `--sidebar` / `--sidebar-foreground` | `#001E2D` / `#AFC6E6` | the Ink nav and its items |
| `--sidebar-primary` / `--sidebar-primary-foreground` | `#0E4EAF` / `#FFFFFF` | the active nav pill |
| `--sidebar-accent` / `--sidebar-accent-foreground` | `#072F68` / `#FFFFFF` | nav hover |
| `--sidebar-border` | white at 10% | nav dividers |
| `--sidebar-ring` | `#8BB4EE` | focus on Ink (8.1:1) |

### Nile colors (`@theme`)

| Token | Value | Use |
|---|---|---|
| `nile-blue` | `#0E4EAF` | brand primary |
| `nile-blue-700` | `#0A3C87` | primary hover |
| `nile-blue-100` | `#DCE8FB` | info badge fill |
| `nile-blue-050` | `#EEF4FE` | icon tiles, hover tint |
| `deep-nile-blue` | `#072F68` | nav hover |
| `bright-nile-blue` | `#2070E1` | focus ring |
| `nile-ink` | `#001E2D` | sidebar, toast, scrims |
| `nile-slate` | `#4D626C` | secondary text |
| `nile-sky` | `#8BB4EE` | text on Ink ("Hands-On Labs") |
| `nile-sky-100` | `#CBDEFA` | the sign in glow |
| `solar-amber` | `#FF6600` | brand accent (decoration) |
| `amber-100` | `#FFE7D4` | amber tint |
| `solar-crimson` | `#EE4A59` | logo, error toast icon |
| `crimson-100` | `#FCE0E3` | danger tile, error alert tint |
| `nile-teal` | `#35D39A` | success toast check |
| `teal-100` | `#D6F5E9` | success badge fill |
| `dawn-violet` | `#8758ED` | brand accent (decoration) |
| `violet-100` | `#ECE3FC` | accent badge fill |
| `cloud-mist` | `#F6F8FB` | page, search box fill |
| `bg-inset` | `#EEF2F8` | neutral badge fill |
| `fg1` | `#001E2D` | primary text |
| `fg2` | `#4D626C` | secondary text |
| `fg3` | `#5D7182` | captions, table headers, placeholders |
| `border-strong` | `#C2CEDD` | outline buttons |
| `success-fg` | `#1A7958` | success badge text |
| `violet-fg` | `#7641EB` | accent badge text |
| `danger-strong` | `#C42A38` | delete icon, danger text |

### AA adjustments

The mock's values that failed AA, and what replaced them:

| Token | Mock | Now | Pair | Ratio |
|---|---|---|---|---|
| `fg3` | `#6B8295` (4.0:1 on white) | `#5D7182` | on white / cloud mist / bg-inset | 5.06 / 4.76 / 4.50 |
| `success-fg` | `#1E8C66` | `#1A7958` | on `teal-100` | 4.62 |
| `violet-fg` | `#8758ED` | `#7641EB` | on `violet-100` | 4.55 |
| `--input` | `#DCE3ED` | `#7D97B7` | on white (control boundary) | 3.01 |
| `bg-nile-cta` | `#EC394C` to `#FF6600` | `#E91B31` to `#C95100` | white text on each stop | 4.50 / 4.51 |

Other checked pairs: white on `nile-blue` 7.70, white on `danger-strong` 5.62,
`nile-blue` on `nile-blue-100` 6.23, `#AFC6E6` on `nile-ink` 9.84, `--ring`
on white 4.70. `tests/design-contrast.test.ts` checks every one.

### Type

Inter through `next/font/google` (self hosted at build, no request to Google
at runtime). Headings semibold (600), body regular (400), buttons bold (700).

| Class | Size | Use |
|---|---|---|
| `text-th` | 11.5px | table headers (bold, uppercase, 0.05em tracking) |
| `text-xs` | 12px | eyebrows |
| `text-pill` | 12.5px | badges, small notes |
| `text-[0.8125rem]` | 13px | form labels, field errors |
| `text-sub` | 13.5px | page subtitles |
| `text-sm` | 14px | body, cells, buttons |
| `text-cell` | 14.5px | inputs, the first cell, nav items |
| `text-lg` | 18px | dialog titles |
| `text-title` | 21px | page titles (0.02em tight tracking) |
| `text-card-title` | 26px | the sign in heading |

### Radii, shadows, motion

| Class | Value | Use |
|---|---|---|
| `rounded-sm` | 8px | icon buttons, nav items |
| `rounded-md` | 10px | inputs |
| `rounded-lg` | 12px | icon tiles |
| `rounded-xl` | 16px | cards |
| `rounded-2xl` | 18px | alert dialogs |
| `rounded-3xl` | 20px | form modal |
| `rounded-4xl` | 24px | sign in card |
| `rounded-full` | pill | buttons, badges, search, toast |

Shadows: `shadow-xs` (cards), `shadow-sm`, `shadow-md` (menus), `shadow-lg`
(dialogs, toast, sign in card), `shadow-cta` (the learner call to action),
`shadow-blue`. All Ink tinted, from the mock.

Gradients: `bg-nile-cta` for any button with text, `bg-nile-cta-brand`
(decoration only), `bg-nile-mark` (avatars, the shield), `bg-nile-brand`
(dividers).

Motion: `ease-nile` (`cubic-bezier(.2,.7,.3,1)`) with `duration-120` (color),
`duration-200` (dialogs, drawer), `duration-360` (toast). With reduced motion
on, transitions and animations are cut to zero.

Breakpoint: `nav:` at 880px. From there up, the sidebar shows and the form
modal centers; below it, the drawer and the bottom sheet.

### Focus

Every focusable element gets a solid 2px `ring` outline, 2px out, from one
unlayered rule in `app/globals.css` that no utility can remove. Controls may
add the mock's soft glow outside it (`focus-visible:ring-3
focus-visible:ring-ring/35`). On Ink, set `[--focus-ring:var(--sidebar-ring)]`
on the container.

## Components

| Piece | File | Use it for |
|---|---|---|
| Button | `components/ui/button.tsx` | `default` (Nile Blue pill), `cta` (learner gradient), `outline`, `secondary`, `ghost`, `destructive`, `link`. Sizes `default` 40px, `sm`, `lg` 48px, `icon` 32px square, `icon-lg` 38px. Pending: `<Spinner data-icon="inline-start" />` plus `disabled`. |
| Badge | `components/ui/badge.tsx` | status pills. `tone` is `info`, `success`, `neutral`, or `accent`; get it from a word with `toneFor()` in `lib/badge-tones.ts`. |
| Field | `components/field.tsx` | one labelled control: `<Field path="clients.0.url" label="URL"><Input name="clientUrl" /></Field>`. It wires the id, `aria-invalid`, `aria-describedby`, and `data-field`, and reads its error from the enclosing FormDialog (or `error`). |
| FormSelect | `components/form-select.tsx` | a Base UI select that submits under `name`; works inside Field. |
| AdminShell | `components/admin/admin-shell.tsx` | mounted once by `app/admin/layout.tsx`. Nav from `ADMIN_NAV` in `lib/admin-nav.ts`. |
| PageHeader | `components/admin/page-header.tsx` | the top of every admin page: `section="testbeds"` (title and subtitle from `ADMIN_NAV`) or `title` plus `subtitle`, and an optional `action`. |
| PageBody | `components/admin/page-body.tsx` | the page's one `<main id="content">`, max 1180px. |
| DataTable | `components/admin/data-table.tsx` | any admin list. Plain data props only: `columns`, `rows` (`id`, `label`, `search`, rendered `cells`, optional `actions`), `searchPlaceholder`, `noun`. |
| FormDialog | `components/admin/form-dialog.tsx` | create and edit forms. `trigger`, `title`, `action` (an `AdminFormState` Server Action), and the fields as children. |
| DeleteFlow | `components/admin/delete-flow.tsx` | a row's delete: `kind`, `id`, `label`, `check`, `remove` (see the contract below). |
| ComingSoon | `components/admin/coming-soon.tsx` | an admin section not built yet. |
| LearnerFrame | `components/learner-frame.tsx` | wraps every learner page: the top bar and the one `<main>`. |
| SkipLink | `components/skip-link.tsx` | first in the admin layout and the learner frame. |
| Toasts | `components/notify.ts` | `notifySuccess(message)` (4s, polite) and `notifyError(message)` (8s, assertive, with Close). One region, mounted in the root layout. |
| shadcn | `components/ui/` | Card, Input, Label, Select, Alert, Empty, Separator, Skeleton, Spinner, Table, Dialog, AlertDialog, Sheet, Toast, all restyled to these tokens. Use them before writing custom markup. |

The gallery at `/admin/ui-gallery` (admin only, not in production) shows
every piece with sample data.

### Contracts

**FormDialog** submits through `AdminFormState` (`app/admin/actions.ts`):

- `saved`: the modal closes, a success toast shows the message, the list
  refreshes (the action calls `revalidatePath("/admin", "layout")`).
- `error` with `fields`: each message shows under its field, every typed
  value stays, focus moves to the first invalid field.
- `error` with only `message`: a destructive Alert above the footer.
- A thrown action: the Alert "Something went wrong. Try again."
- While pending, Save shows a spinner, and Cancel, Escape, and Close do
  nothing. Closing discards the form; reopening starts empty.

**DeleteFlow** takes two Server Actions typed in `lib/delete-flow.ts`:

- `check(id)` returns `ok(blockers)`; `ok([])` means safe to confirm, and
  `err("unavailable")` shows an error toast.
- `remove(id)` locks, checks again, and deletes in one transaction. It
  returns `ok()`, `err({ kind: "blocked", blockers })` (the blocked dialog
  replaces the confirm), or `err({ kind: "failed", message })` (an error
  toast).
- The blocked dialog's copy per kind is `BLOCKED_COPY`. Both actions call
  `requireAdmin()`.

### Error display rule

Field errors go under their field. A failure with no field goes to a
destructive Alert inside an open form modal, and to an error toast
everywhere else. Success is a toast, never inline text.

## Standard definition

An admin section page is a Server Component: `requireAdmin()`, load the rows,
build DataTable rows (rendered cells, a joined `search` string), and render
PageHeader with a FormDialog action, then PageBody with the DataTable. Only
data, rendered nodes, and Server Actions cross into client pieces, never a
plain function. Row actions are rendered nodes, for example
`actions: <DeleteFlow kind="testbed_type" … />`. See
`app/admin/testbed-types/page.tsx`.

It replaces per page `<main>` wrappers, Card stacks, and hand drawn tables in
admin pages; inline success lines; `components/form-field.tsx`;
render function props from Server Components; and raw colors.

Enforcement: `tests/style-guard.test.ts` and `tests/design-contrast.test.ts`
(CI), and the axe, keyboard, and screenshot specs in `e2e/` (local, they need
real Authentik).

Exceptions: `components/ui/` may keep shadcn's own `dark:` classes and
internal values. Email templates (feature 15) use inline styles with the hex
values above, because mail clients ignore CSS variables.

## Allowed differences from the mock

- The AA adjusted colors above (most visible: darker input borders and the
  deeper CTA gradient).
- Copy without dashes, and without the mock's "This screen is a mock" note.
- Toasts last 4s (success) and 8s (error) instead of 2.6s.
- Columns and buttons for features not built yet are absent.

## Assets

`public/brand/nile-logo.png` (color) and `public/brand/nile-logo-white.png`
(on Ink), extracted from the mock; render through `next/image` with
`alt="Nile"`, sized by height with `w-auto`. `app/icon.png` and
`app/apple-icon.png` are the shield alone. Official SVGs are owed by the
owner (spec 0005 follow up).
