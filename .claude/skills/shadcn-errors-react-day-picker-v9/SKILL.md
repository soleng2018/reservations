---
name: shadcn-errors-react-day-picker-v9
description: >
  Use when a shadcn `Calendar` (or any direct `react-day-picker` DayPicker)
  silently renders nothing, throws a TypeScript error on the `selected`
  prop, loses every CSS rule after a `react-day-picker` upgrade, shows
  an unstyled grid of buttons, fails to compile a custom `Caption` /
  `Day` / `IconLeft` / `IconRight` component, fires a Matcher warning
  for `disabledDays`, ignores `selectedDays` entirely, throws
  "DayPickerProps is not a function" or "Cannot read properties of
  undefined (reading 'mode')", crashes after `npm install
  react-day-picker@9` on a code base that pre-dates the v9 release, or
  no longer responds to the `fromMonth` / `toMonth` boundary props.
  Prevents the v8 syntax in v9 trap (the file compiles but the calendar
  is read-only, invisible, or unstyled because every prop name moved),
  the missing `mode` prop trap (v9 makes `mode` mandatory on every
  `selected` usage and TypeScript fails the type narrowing), the
  classNames-with-old-keys trap (v9 keys every entry by a `UI` enum
  string like `day_button` / `month_caption` / `range_start`, the v8
  keys `day` / `cell` / `caption` no longer match any element), the
  Caption-renamed-MonthCaption trap (custom captions registered under
  `components.Caption` are silently ignored, v9 reads
  `components.MonthCaption`), the modifiers-as-array trap (v9 expects
  `modifiers={{ name: Matcher }}` not `modifiers={[...]}`), the
  formatter-returns-JSX trap (v9 formatters MUST return a `string`,
  React markup goes through a custom component), the CSS-import-path
  trap (v8 `react-day-picker/dist/style.css` 404s on v9, use
  `react-day-picker/style.css`), the boundary-prop trap (`fromMonth` /
  `toMonth` / `fromDate` / `toDate` were renamed `startMonth` /
  `endMonth` plus `hidden` matcher), and the Day-renderer trap (custom
  `<Day>` from v8 expected `(props, ...)` signature and is replaced by
  `components.DayButton` with `day` / `modifiers` props). Covers the
  v8 -> v9 prop rename table (selectedDays -> selected, disabledDays
  -> disabled, modifiers as object of Matchers, Caption ->
  MonthCaption, IconLeft / IconRight -> single Chevron, Row -> Week,
  HeadRow -> Weekdays, fromMonth / toMonth -> startMonth / endMonth,
  fromDate / toDate -> hidden + boundary props), the `mode="single" |
  "multiple" | "range"` requirement contract, the `classNames` UI-enum
  key system with `getDefaultClassNames()`, the `dateLib` adapter
  pattern that replaces direct `date-fns` imports, the `month` /
  `defaultMonth` controlled vs uncontrolled pair, the formatter
  string-return contract, the symptoms-to-fix matrix that maps each
  silent failure mode to the exact prop rename, and the canonical
  recovery flow `npx shadcn@latest add calendar --overwrite` when
  the shadcn-side Calendar source is itself a v8 vintage.
  Keywords: react-day-picker v9, calendar v8 to v9, day-picker
  breaking change, selectedDays renamed, disabledDays renamed,
  Caption renamed MonthCaption, mode prop required, calendar
  TypeScript error, calendar style broken upgrade, dateLib adapter,
  react-day-picker upgrade, shadcn calendar broken, calendar blank
  render, calendar invisible after upgrade, calendar lost styles,
  modifiers as object, modifiers as array error, fromMonth removed,
  toMonth removed, startMonth endMonth, IconLeft IconRight Chevron,
  Row Week renamed, HeadRow Weekdays renamed, DayPickerSingleProps
  renamed PropsSingle, useNavigation useDayPicker, react-day-picker
  style.css path, dist style.css 404, getDefaultClassNames, UI enum
  classNames, components.DayButton, custom Day renderer v9, formatter
  must return string, shadcn add calendar overwrite, issue 4366
license: MIT
compatibility: "Designed for Claude Code. Requires shadcn ui evergreen-2026 with react-day-picker v9 (v9.0.0 released mid-2024, current minor v9.14.x at 2026-05-19)."
metadata:
  author: OpenAEC-Foundation
  version: "1.0"
---

# react-day-picker v8 -> v9 Errors in the shadcn Calendar

A shadcn `Calendar` is a thin wrapper around `react-day-picker`. The
`react-day-picker` 9.0.0 release (mid-2024) reshaped almost every public
prop name, the classNames key system, the components-override surface,
and the formatter contract. Every v8 prop name still parses as valid
JSX in v9 (`selectedDays`, `disabledDays`, `modifiers={[...]}`,
`components={{ Caption }}`), but the v9 DayPicker simply ignores them.
The symptom is therefore SILENT : the page compiles, the calendar
mounts, and nothing happens (no selection, no styles, no custom
caption). TypeScript narrows the typed errors to a single rule on
`mode` ; the rest manifests as visual breakage.

This skill maps each v8 syntax shape onto its v9 replacement, lists the
TypeScript error messages that surface for the typed cases, and
documents the canonical recovery flow when the shadcn-side
`components/ui/calendar.tsx` itself pre-dates the v9 release.

Companion skills :

- `shadcn-syntax-calendar-datepicker` (Batch B7) : the v9 API surface
  in full and the DatePicker composition recipe (Popover + Calendar +
  Input). Read this skill FIRST for the green-field v9 syntax ; this
  errors skill assumes you already know the v9 shape and need to
  migrate v8 code or diagnose a v8-shape regression.
- `shadcn-errors-cli-sync-mismatch` : the canonical recovery flow
  uses `npx shadcn@latest add calendar --overwrite` when the
  shadcn-side calendar file is itself stale.
- `shadcn-errors-styling-conflicts` : when CSS classes look right but
  the calendar is still unstyled, the `react-day-picker/style.css`
  import may have moved.

## Quick Reference : v8 -> v9 Prop Rename Table

For every prop the calendar accepts, v9 either keeps the v8 name, renames
it, or removes it entirely. This table is the single most important
reference in this skill. ALWAYS consult it before changing any prop.

| v8 prop / API | v9 prop / API | Type / Notes |
|---------------|---------------|--------------|
| `selectedDays` | `selected` | `Date \| Date[] \| DateRange \| undefined` ; matches the `mode` |
| `disabledDays` | `disabled` | `Matcher \| Matcher[]` |
| `modifiers={[...]}` | `modifiers={{ name: Matcher }}` | object of Matchers, NOT an array |
| `modifiersStyles` | `modifiersStyles` | unchanged, but keys map to v9 modifier names |
| `modifiersClassNames` | `modifiersClassNames` | unchanged, but keys map to v9 modifier names |
| `components.Caption` | `components.MonthCaption` | the caption above the month grid |
| `components.IconLeft` | `components.Chevron` | single component receives `orientation: "left" \| "right" \| "up" \| "down"` |
| `components.IconRight` | `components.Chevron` | same as above |
| `components.Row` | `components.Week` | one row of days |
| `components.HeadRow` | `components.Weekdays` | the header row with weekday names |
| `components.Day` | `components.DayButton` | signature changed to `({ day, modifiers, ...props })` |
| `fromMonth` | `startMonth` | `Date` |
| `toMonth` | `endMonth` | `Date` |
| `fromDate` | `startMonth` + `hidden` matcher | use `hidden={{ before: Date }}` to gray-out earlier days |
| `toDate` | `endMonth` + `hidden` matcher | use `hidden={{ after: Date }}` |
| `month` | `month` | unchanged (controlled current month) |
| `defaultMonth` | `defaultMonth` | unchanged (uncontrolled initial month) |
| `numberOfMonths` | `numberOfMonths` | unchanged |
| `mode` IMPLICIT (`selectedDays: Date`) | `mode="single" \| "multiple" \| "range"` REQUIRED | v9 demands explicit mode when `selected` is set |
| `onSelect` (per-mode) | `onSelect` (per-mode) | unchanged, but the value type is narrowed by `mode` |
| `classNames` keyed by free strings (`day`, `cell`, `caption`) | `classNames` keyed by `UI` enum strings (`day`, `day_button`, `cell` REMOVED, `month_caption`, `range_start` etc.) | see UI enum in `references/methods.md` |
| `formatCaption: (m) => <strong>...</strong>` | `formatCaption: (m) => "..."` | v9 formatters MUST return `string`, NOT JSX |
| direct `date-fns` import inside DayPicker | `dateLib` adapter prop | pass a `DateLib` adapter so locales / time-zones flow through the picker |
| `react-day-picker/dist/style.css` | `react-day-picker/style.css` | new import path, the old one 404s |
| `DayPickerSingleProps` | `PropsSingle` | renamed type |
| `DayPickerMultipleProps` | `PropsMulti` | renamed type |
| `DayPickerRangeProps` | `PropsRange` | renamed type |
| `useNavigation` | `useDayPicker` | renamed hook |

Verified at https://daypicker.dev/v9/upgrading (2026-05-19).

## Quick Reference : The `mode` Prop is REQUIRED in v9

In v8, `selectedDays={date}` IMPLIED `mode="single"`. v9 removes the
implicit form. The `mode` prop is now part of the union type that
narrows `selected` and `onSelect` :

```tsx
// CORRECT v9 : single
<Calendar mode="single" selected={date} onSelect={setDate} />

// CORRECT v9 : multiple
<Calendar mode="multiple" selected={dates} onSelect={setDates} />

// CORRECT v9 : range
<Calendar mode="range" selected={range} onSelect={setRange} />

// WRONG : mode missing, TypeScript error
<Calendar selected={date} onSelect={setDate} />
// Type '{ selected: Date; onSelect: ... }' is not assignable to type
// 'DayPickerProps'. Property 'mode' is missing.
```

Without `mode`, v9 falls back to no selection at all : the picker
renders, dates are clickable, but the click never updates state.
TypeScript catches this at compile time IF `strict: true` is on.

## Quick Reference : `classNames` is Keyed by the `UI` Enum

v9 publishes a `UI` string enum that names every visual slot in the
calendar (root, months, month, nav, button_previous, button_next,
month_caption, dropdowns, caption_label, table, weekdays, weekday,
week, day, day_button, range_start, range_middle, range_end, today,
outside, disabled, hidden, week_number, week_number_header, etc.).

The v8 keys (`cell`, `day`, `caption`, `head_row`, `nav_button`) either
moved (`day` is now the table cell, `day_button` is the button inside
it) or vanished entirely. Use `getDefaultClassNames()` and merge with
`cn(...)` so the shadcn defaults stay applied :

```tsx
import { DayPicker, getDefaultClassNames } from "react-day-picker"
import { cn } from "@/lib/utils"

const defaultClassNames = getDefaultClassNames()

<DayPicker
  classNames={{
    root: cn("w-fit", defaultClassNames.root),
    month_caption: cn("...your tailwind...", defaultClassNames.month_caption),
    day: cn("...your tailwind...", defaultClassNames.day),
    day_button: cn("...your tailwind...", defaultClassNames.day_button),
    range_start: cn("rounded-l-md bg-accent", defaultClassNames.range_start),
    // any v8 key (`cell`, `head_row`) is ignored
  }}
/>
```

Verified at https://github.com/shadcn-ui/ui/blob/main/apps/v4/registry/new-york-v4/ui/calendar.tsx
(2026-05-19) : the shadcn Calendar source itself uses
`getDefaultClassNames()` and merges every v9 key.

## Quick Reference : `dateLib` Adapter Replaces Direct date-fns

v8 imported `date-fns` directly inside DayPicker and accepted a
`locale` prop. v9 introduces a `dateLib` adapter so the calendar can
work with `date-fns`, `dayjs`, `luxon`, native `Intl`, or a custom
adapter. The shadcn Calendar still accepts `locale` (forwarded to
the default adapter), but for time-zones, custom week starts, or
non-Gregorian calendars the `dateLib` prop is the v9 surface :

```tsx
import { DayPicker } from "react-day-picker"
import { fr } from "date-fns/locale"

// CORRECT v9 : locale only
<DayPicker locale={fr} />

// CORRECT v9 : dateLib with time-zone
<DayPicker dateLib={{ ...defaultDateLib, timeZone: "Europe/Amsterdam" }} />

// WRONG : v8 used `useNavigation` hook to read the locale ; v9 renamed it
import { useDayPicker } from "react-day-picker"  // not useNavigation
```

See `references/methods.md` for the full `DateLib` signature.

## Quick Reference : Symptoms-to-Fix Matrix

Match the symptom on the left to the exact v8 -> v9 cause on the right.
ALWAYS run through this matrix BEFORE touching code.

| Symptom | Cause | Fix |
|---------|-------|-----|
| Calendar renders but no day is highlighted as selected | `selectedDays` used instead of `selected` | rename to `selected`, add `mode="single"` |
| Disabled days are still clickable | `disabledDays` used instead of `disabled` | rename to `disabled` |
| Custom month-header component never appears | `components.Caption` used | rename to `components.MonthCaption` |
| Left / right arrow icons are gone | `components.IconLeft` / `IconRight` used | merge into `components.Chevron` with `orientation` switch |
| TypeScript error : `Property 'mode' is missing` | v9 demands `mode` | add `mode="single" \| "multiple" \| "range"` |
| TypeScript error : `selectedDays does not exist on type DayPickerProps` | v8 prop name | rename to `selected` |
| Calendar is unstyled, looks like a raw HTML table | `react-day-picker/dist/style.css` import 404s on v9, OR `classNames` uses v8 keys | change import to `react-day-picker/style.css` AND rekey to v9 `UI` strings |
| `modifiers.weekend` not applied to any day | `modifiers={[{...}]}` array form | switch to object form `modifiers={{ weekend: Matcher }}` |
| Custom `<Day>` renderer errors with "Cannot read property of undefined" | v8 Day signature | switch to `components.DayButton` with `({ day, modifiers, ...props })` |
| Range selection ignores `fromMonth` / `toMonth` boundaries | v8 boundary props | rename to `startMonth` / `endMonth` |
| `formatCaption` throws "Objects are not valid as a React child" | v9 formatters must return `string` | return a string ; for JSX use `components.MonthCaption` |
| Import error : `Module not found: react-day-picker/dist/style.css` | v9 moved the CSS | use `react-day-picker/style.css` |
| `useNavigation is not a function` | v9 renamed the hook | use `useDayPicker` |

## Quick Reference : Canonical Recovery Flow

If your shadcn-side `components/ui/calendar.tsx` PRE-dates the v9 release
(check : does it import `getDefaultClassNames` ? does it set
`mode="single"` defaults ? does it map `Chevron` ?), the file itself is
v8-shape. Manual patching is fragile. The supported recovery is to
re-run the shadcn CLI :

```bash
npx shadcn@latest diff calendar    # preview the v9 calendar source
npx shadcn@latest add calendar --overwrite   # rewrite to v9 shape
```

This regenerates `components/ui/calendar.tsx` with the v9
`getDefaultClassNames()` / `components.Chevron` / `components.DayButton`
wiring. After overwrite, any consumer site that still passes v8 props
through Calendar will surface TypeScript errors at the consumer site,
which you fix using the rename table above.

Verified at https://github.com/shadcn-ui/ui/issues/4366 (2026-05-19,
97 reactions, open) : the canonical maintainer-recommended fix is to
re-run `shadcn add calendar --overwrite`.

## Decision Tree : Diagnosing a Broken Calendar After an Upgrade

```
START : Calendar broken after `react-day-picker@9` install
  |
  +-- Does TypeScript compile ?
  |    +-- NO : read the error
  |    |    +-- "Property 'mode' is missing" -> add `mode="single|multiple|range"`
  |    |    +-- "selectedDays does not exist" -> rename to `selected`
  |    |    +-- "disabledDays does not exist" -> rename to `disabled`
  |    |    +-- "DayPickerSingleProps does not exist" -> rename to `PropsSingle`
  |    +-- YES : continue
  |
  +-- Does Calendar render at all ?
  |    +-- NO : check the CSS import path (must be `react-day-picker/style.css`)
  |    +-- YES : continue
  |
  +-- Are styles applied ?
  |    +-- NO : `classNames` still keyed by v8 strings ; rekey using `UI` enum
  |    +-- YES : continue
  |
  +-- Does selection update on click ?
  |    +-- NO : `mode` missing ; selection is silently disabled
  |    +-- YES : continue
  |
  +-- Are custom captions / icons appearing ?
  |    +-- NO : `components.Caption` / `IconLeft` / `IconRight` ignored ; rename to MonthCaption / Chevron
  |    +-- YES : DONE
```

## Cross-File Companion : When To Re-Add Calendar

If MORE THAN 3 v8 prop names appear in the project AND the
`components/ui/calendar.tsx` file does NOT contain
`getDefaultClassNames`, do NOT patch by hand. Run :

```bash
npx shadcn@latest add calendar --overwrite
```

Then fix the consumer call sites with the rename table. Patching a
v8-shape `calendar.tsx` to v9 by hand creates a long tail of subtle
bugs (classNames keys, components signatures, formatter contracts)
that the CLI rewrite resolves in one shot.

## Reference Files

- `references/methods.md` : full v8 -> v9 API rename table, `UI` enum
  reference, `DateLib` adapter signature, `Matcher` type, components
  override map, formatter contract.
- `references/examples.md` : v8 single-date code -> v9 equivalent ;
  v8 range -> v9 with `DateRange` ; v8 `disabledDays` -> v9
  `disabled` ; v8 custom `Caption` -> v9 `MonthCaption` ; v8
  `modifiers` array -> v9 `modifiers` object of Matchers ; `dateLib`
  with a custom locale.
- `references/anti-patterns.md` : six recurring v8-shape-in-v9
  failure modes with symptom, root cause, and verified fix.

## Sources

- https://daypicker.dev/v9/upgrading (v9 official upgrade guide, last
  verified 2026-05-19)
- https://daypicker.dev/v9/guides/custom-modifiers (verified
  2026-05-19)
- https://github.com/shadcn-ui/ui/blob/main/apps/v4/registry/new-york-v4/ui/calendar.tsx
  (shadcn Calendar v9-compatible source, verified 2026-05-19)
- https://github.com/shadcn-ui/ui/issues/4366 (canonical regression
  issue, 97 reactions, verified 2026-05-19)
- https://ui.shadcn.com/docs/components/calendar (shadcn Calendar
  docs, verified 2026-05-19)
