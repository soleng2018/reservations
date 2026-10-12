---
name: shadcn-syntax-calendar-datepicker
description: >
  Use when adding, customising, or debugging a shadcn ui Calendar or
  Date Picker, choosing between the three react-day-picker v9 selection
  modes (single / multiple / range), typing the `selected` state and the
  `onSelect` callback for each mode (Date vs Date[] vs DateRange), wiring
  a DatePicker by composing Calendar inside a Popover with a Button
  trigger that formats the date via date-fns, localising the calendar to
  Dutch / German / French via the `dateLib` adapter, disabling specific
  dates with a `disabled` matcher or a date-fns predicate, styling the
  calendar via `classNames` + `modifiers` + `modifiersClassNames`,
  swapping the day renderer through the `components` prop, or migrating
  an existing Calendar file from react-day-picker v8 to v9 after running
  `shadcn add calendar --overwrite`.
  Prevents the canonical Calendar failures : omitting the required
  `mode` prop so TypeScript narrows `selected` to `undefined` and the
  calendar never marks any day as selected, importing v8-only props
  (`selectedDays`, `disabledDays`, `fromDate`, `toDate`, `fromMonth`,
  `toMonth`, `numberOfMonths` typing) that no longer exist on the v9
  surface, declaring `useState<Date>()` and then passing the setter to
  `mode="range"` which expects `DateRange | undefined`, forgetting
  `"use client"` at the top of any file that mounts a Calendar so the
  `Intl.DateTimeFormat()` call inside react-day-picker triggers a
  hydration mismatch in Next.js App Router, hand-styling individual day
  cells with arbitrary Tailwind instead of routing through
  `classNames.day` / `modifiers` so future `shadcn add calendar
  --overwrite` runs nuke the customisation, and treating DatePicker as
  a single importable primitive when it is a documented Popover +
  Button + Calendar recipe with no `<DatePicker />` export.
  Covers the v9 Mode union (`"single" | "multiple" | "range"`),
  exact selected/onSelect type per mode, the DateRange type
  (`{ from: Date | undefined; to?: Date | undefined }`),
  the v8 -> v9 prop renames (`fromMonth`/`fromYear` ->
  `startMonth`, `toMonth`/`toYear` -> `endMonth`,
  `fromDate`/`toDate` -> `hidden` + before/after matcher,
  `Caption` -> `MonthCaption`, `Row` -> `Week`, `HeadRow` ->
  `Weekdays`, `IconLeft`/`IconRight` -> single `Chevron`,
  `day_selected` -> `selected`, `day_disabled` -> `disabled`),
  the shadcn Calendar wrapper props (`buttonVariant`,
  `captionLayout`, `showOutsideDays`, `formatters`, `components`),
  the locked-down `classNames` keys exposed by `getDefaultClassNames()`,
  the Popover + Button DatePicker recipe for single / range / preset
  variants, the date-fns `format(..., "PPP")` and `format(..., "LLL dd, y")`
  trigger-label patterns, locale wiring via the v9 dateLib adapter and
  `date-fns/locale/nl`, RSC safety (`"use client"` mandatory), and the
  forward pointer to `shadcn-errors-react-day-picker-v9` for recovery
  from the v8 -> v9 silent breakage.
  Keywords: shadcn calendar, shadcn date picker, datepicker, Calendar
  component, DatePicker recipe, react-day-picker v9, react-day-picker
  v8 to v9, DayPicker, mode single, mode multiple, mode range,
  DateRange type, onSelect callback, selected Date undefined, calendar
  disabled dates, fromDate toDate, startMonth endMonth, captionLayout
  dropdown, dateLib adapter, locale nl date-fns, getDefaultClassNames,
  classNames day selected, modifiers modifiersClassNames, CalendarDayButton,
  components prop, custom day renderer, Chevron orientation, MonthCaption,
  Popover Calendar Button, asChild PopoverTrigger, format PPP, format LLL,
  Pick a date placeholder, numberOfMonths range, defaultMonth,
  showOutsideDays, hydration mismatch Intl DateTimeFormat, use client
  Calendar, shadcn add calendar overwrite, calendar v9 breaking change,
  selectedDays renamed, fromDate hidden before after matcher,
  how do I make a date picker, how do I disable past dates,
  how do I localize the calendar, calendar nothing selected,
  range from to optional, DateRange from undefined.
license: MIT
compatibility: "Designed for Claude Code. Requires shadcn ui evergreen-2026 with react-day-picker v9 (BREAKING change from v8). For v8 -> v9 recovery, see shadcn-errors-react-day-picker-v9."
metadata:
  author: OpenAEC-Foundation
  version: "1.0"
---

# shadcn ui : Calendar + DatePicker Syntax

The shadcn Calendar is a thin wrapper over **react-day-picker v9** (`DayPicker` re-exported as `Calendar`). The DatePicker is NOT a primitive : it is a documented composition of `Popover` + `Button` (as `PopoverTrigger asChild`) + `Calendar` (inside `PopoverContent`). Every other "date input" pattern (preset shortcuts, range pickers, date+time hybrids) derives from this recipe.

The single most common failure on this primitive is the silent **v8 -> v9 break** : the API was redesigned mid-2025 (issue #4366, 97 reactions). Old Calendar source files that pre-date `shadcn` v4.x will silently misbehave on `react-day-picker@9.0.0`. Recovery is `shadcn add calendar --overwrite`. See **Companion : shadcn-errors-react-day-picker-v9** for the full migration playbook.

## Quick Reference

### Canonical Calendar call

```tsx
"use client"

import * as React from "react"
import { Calendar } from "@/components/ui/calendar"

export default function CalendarDemo() {
  const [date, setDate] = React.useState<Date | undefined>(new Date())

  return (
    <Calendar
      mode="single"
      selected={date}
      onSelect={setDate}
      className="rounded-md border shadow-sm"
      captionLayout="dropdown"
    />
  )
}
```

`mode` is **mandatory** in v9 : without it, TypeScript narrows `selected` to `undefined` and no day is ever marked selected. `"use client"` is non-optional : Calendar calls `Intl.DateTimeFormat()` internally and will cause a Next.js App Router hydration mismatch if rendered as an RSC.

### Mode decision table

| User intent | `mode` | `selected` type | `onSelect` signature |
|-------------|--------|-----------------|----------------------|
| Pick exactly one day | `"single"` | `Date \| undefined` | `(date: Date \| undefined) => void` |
| Pick any number of days | `"multiple"` | `Date[] \| undefined` | `(dates: Date[] \| undefined) => void` |
| Pick a start + end range | `"range"` | `DateRange \| undefined` | `(range: DateRange \| undefined) => void` |

`DateRange` is `{ from: Date \| undefined; to?: Date \| undefined }`. ALWAYS read `from` before `to` ; while the user is mid-drag, `to` is `undefined`. NEVER assume both ends are present.

If `required: true` is also passed, the corresponding `undefined` branch is removed from the type (single becomes `Date`, multiple becomes `Date[]`, range becomes `DateRange`). NEVER mix `required: true` with `useState<Date | undefined>()` ; the setter will type-error.

### Four invariants

1. ALWAYS pass `mode` explicitly. NEVER rely on a "default" mode ; v9 has no default and TypeScript will narrow `selected` to `undefined` silently if `mode` is omitted.
2. ALWAYS prefix the file with `"use client"`. NEVER mount Calendar in a Server Component ; `Intl.DateTimeFormat()` runs in the renderer and causes a hydration mismatch.
3. ALWAYS type the state to match the mode (`useState<Date | undefined>()` for single, `useState<Date[] | undefined>()` for multiple, `useState<DateRange | undefined>()` for range). NEVER reuse a `Date` setter for `mode="range"`.
4. ALWAYS treat the DatePicker as a recipe, NOT a component. NEVER write `import { DatePicker } from "@/components/ui/date-picker"` ; there is no such export. Compose `Popover` + `Button` (`asChild` on `PopoverTrigger`) + `Calendar`.

## Decision Tree 1 : Which mode?

```
Q1. Does the user pick a single calendar day (birthday, deadline,
    appointment)?
    yes -> mode="single" + useState<Date | undefined>()
    no  -> Q2

Q2. Does the user pick zero or more days, with no implied order
    (multi-day absence form, "available days" booking)?
    yes -> mode="multiple" + useState<Date[] | undefined>()
    no  -> Q3

Q3. Does the user pick a continuous span from a start day to an end
    day (holiday request, report period filter, hotel booking)?
    yes -> mode="range" + useState<DateRange | undefined>()
         + ALWAYS render Calendar with numberOfMonths={2} for the
           two-month side-by-side range UX
    no  -> reconsider : single, multiple, or range covers every
           react-day-picker v9 selection. There is no other mode.
```

## Decision Tree 2 : Calendar standalone or DatePicker recipe?

```
Q1. Should the calendar be visible at all times (admin grid, booking
    page main surface, dashboard calendar)?
    yes -> render <Calendar /> directly ; do NOT wrap in Popover
    no  -> Q2

Q2. Should the calendar appear only when the user opens an input
    field or a button (form field, filter trigger, header date
    picker)?
    yes -> DatePicker recipe : Popover + Button (asChild on
           PopoverTrigger) + Calendar inside PopoverContent ;
           format the selected date in the Button label via
           date-fns format()
    no  -> reconsider : either the calendar is always visible (Q1)
           or it is gated by a trigger (Q2). There is no third
           presentation.
```

## Decision Tree 3 : Style override : `className` vs `classNames` vs `modifiers`?

```
Q1. Are you styling the OUTER calendar wrapper (border, padding,
    background)?
    yes -> className="..." on <Calendar /> ; merges via cn() in
           the shadcn wrapper
    no  -> Q2

Q2. Are you restyling a structural slot of the day grid (the row of
    weekday labels, the previous/next nav buttons, the day cell
    itself, the dropdown caption)?
    yes -> classNames={{ slot_key: "tailwind classes" }} ; valid
           keys come from getDefaultClassNames() and include root,
           months, month, nav, button_previous, button_next,
           month_caption, dropdowns, dropdown_root, caption_label,
           weekdays, weekday, week, day, range_start, range_middle,
           range_end, today, outside, disabled, hidden
    no  -> Q3

Q3. Are you flagging SOME days as semantically special (holidays,
    booked, available, today's-deadline) and want to style THOSE
    specifically?
    yes -> modifiers={{ holiday: holidayDates }} +
           modifiersClassNames={{ holiday: "bg-red-100" }} ; the
           wrapper auto-applies the className whenever a day
           matches the modifier predicate
    no  -> Q4

Q4. Are you replacing the rendered DOM for a slot (custom day
    button, custom chevron icon, custom dropdown)?
    yes -> components={{ DayButton: MyDayButton, Chevron: MyIcon }}
    no  -> reconsider : every Calendar customisation maps to one
           of className / classNames / modifiers / components.
           NEVER reach into Calendar.tsx with patches.
```

## Patterns

### Pattern 1 : Single-date Calendar (standalone)

```tsx
"use client"

import * as React from "react"
import { Calendar } from "@/components/ui/calendar"

export default function SingleCalendar() {
  const [date, setDate] = React.useState<Date | undefined>(new Date())

  return (
    <Calendar
      mode="single"
      selected={date}
      onSelect={setDate}
      className="rounded-md border shadow-sm"
    />
  )
}
```

ALWAYS type the state as `Date | undefined` ; the `onSelect` callback receives `undefined` when the user clicks the currently-selected day a second time (deselect).

### Pattern 2 : Range Calendar with two-month side-by-side

```tsx
"use client"

import * as React from "react"
import { type DateRange } from "react-day-picker"
import { Calendar } from "@/components/ui/calendar"

export default function RangeCalendar() {
  const [range, setRange] = React.useState<DateRange | undefined>()

  return (
    <Calendar
      mode="range"
      selected={range}
      onSelect={setRange}
      numberOfMonths={2}
      defaultMonth={range?.from}
    />
  )
}
```

`DateRange` is imported from `react-day-picker`, NOT from `@/components/ui/calendar` ; the shadcn wrapper does not re-export it. `numberOfMonths={2}` is the canonical range UX.

### Pattern 3 : DatePicker recipe (Popover + Button + Calendar)

```tsx
"use client"

import * as React from "react"
import { format } from "date-fns"
import { CalendarIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

export function DatePicker() {
  const [date, setDate] = React.useState<Date | undefined>()

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className={cn(
            "w-[240px] justify-start text-left font-normal",
            !date && "text-muted-foreground"
          )}
        >
          <CalendarIcon />
          {date ? format(date, "PPP") : <span>Pick a date</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar mode="single" selected={date} onSelect={setDate} />
      </PopoverContent>
    </Popover>
  )
}
```

ALWAYS use `asChild` on `PopoverTrigger` so the Button (not a wrapper `<div>`) becomes the accessible trigger. NEVER nest a Button inside a Button. ALWAYS render the selected date via `format(date, "PPP")` (date-fns localised long form) ; raw `date.toString()` leaks the GMT offset into the label.

### Pattern 4 : DatePicker range recipe with two-month popover

```tsx
"use client"

import * as React from "react"
import { addDays, format } from "date-fns"
import { CalendarIcon } from "lucide-react"
import { type DateRange } from "react-day-picker"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

export function DatePickerRange() {
  const [date, setDate] = React.useState<DateRange | undefined>({
    from: new Date(),
    to: addDays(new Date(), 7),
  })

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className={cn(
            "w-[300px] justify-start text-left font-normal",
            !date && "text-muted-foreground"
          )}
        >
          <CalendarIcon />
          {date?.from ? (
            date.to ? (
              <>
                {format(date.from, "LLL dd, y")} -{" "}
                {format(date.to, "LLL dd, y")}
              </>
            ) : (
              format(date.from, "LLL dd, y")
            )
          ) : (
            <span>Pick a date</span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="range"
          defaultMonth={date?.from}
          selected={date}
          onSelect={setDate}
          numberOfMonths={2}
        />
      </PopoverContent>
    </Popover>
  )
}
```

ALWAYS branch on `date?.from` first, THEN on `date.to`, because mid-drag the user has chosen the start but not yet the end. NEVER assume both ends are populated when rendering the label.

### Pattern 5 : Disabled dates (past, weekends, custom predicate)

```tsx
import { isBefore, startOfToday, isWeekend } from "date-fns"

// Disable everything before today (no past dates)
<Calendar
  mode="single"
  selected={date}
  onSelect={setDate}
  disabled={(d) => isBefore(d, startOfToday())}
/>

// Disable weekends
<Calendar
  mode="single"
  selected={date}
  onSelect={setDate}
  disabled={isWeekend}
/>

// Disable a fixed array
<Calendar
  mode="single"
  selected={date}
  onSelect={setDate}
  disabled={[new Date(2026, 11, 25), new Date(2026, 0, 1)]}
/>
```

`disabled` accepts a `Date`, `Date[]`, a `(date: Date) => boolean` predicate, OR any of the v9 matcher objects (`{ before: Date }`, `{ after: Date }`, `{ from: Date; to: Date }`, `{ dayOfWeek: number[] }`). NEVER use the v8 prop name `disabledDays`.

### Pattern 6 : Locale via date-fns adapter

The shadcn wrapper does not expose a `locale` prop directly ; locale flows through `react-day-picker`'s built-in date-fns adapter via the `locale` prop, which is passed through `...props` :

```tsx
"use client"

import { nl } from "date-fns/locale"
import { Calendar } from "@/components/ui/calendar"

<Calendar
  mode="single"
  selected={date}
  onSelect={setDate}
  locale={nl}
/>
```

For non-Gregorian calendars (Persian, Hijri), import from the dedicated entry points (`react-day-picker/persian`, `react-day-picker/hijri`) ; do NOT pass them through `locale`. See methods.md for the full `dateLib` adapter signature.

### Pattern 7 : Modifiers + modifiersClassNames (semantic day styling)

```tsx
const holidays = [new Date(2026, 11, 25), new Date(2026, 11, 26)]
const booked = [new Date(2026, 5, 10), new Date(2026, 5, 11)]

<Calendar
  mode="single"
  selected={date}
  onSelect={setDate}
  modifiers={{ holiday: holidays, booked }}
  modifiersClassNames={{
    holiday: "bg-red-100 text-red-900",
    booked: "line-through opacity-50",
  }}
/>
```

ALWAYS prefer `modifiers` + `modifiersClassNames` for semantic-day styling. NEVER patch individual day cells by hand : the next `shadcn add calendar --overwrite` will erase the patch.

## v8 -> v9 migration callout

If the project's `components/ui/calendar.tsx` was generated before mid-2025 it predates react-day-picker v9 and will silently break after a `pnpm update react-day-picker`. The fastest recovery is :

```bash
pnpm dlx shadcn@latest add calendar --overwrite
```

This re-pulls the v9-compatible source from the registry. The v8 -> v9 prop renames you will see in old code :

| v8 prop / name | v9 replacement |
|----------------|----------------|
| `fromMonth` / `fromYear` | `startMonth` |
| `toMonth` / `toYear` | `endMonth` |
| `fromDate` / `toDate` | `hidden` with `{ before }` / `{ after }` matcher |
| `selectedDays` | `selected` |
| `disabledDays` | `disabled` |
| `Caption` (component) | `MonthCaption` |
| `Row` (component) | `Week` |
| `HeadRow` (component) | `Weekdays` |
| `IconLeft` + `IconRight` | single `Chevron` with `orientation` |
| `day_selected` (className key) | `selected` |
| `day_disabled` (className key) | `disabled` |
| `cell` (className key) | `day` |
| `day` (className key) | `day_button` |

Full migration table and recovery playbook : **shadcn-errors-react-day-picker-v9**.

## Reference Links

- [methods.md](references/methods.md) : Full prop signatures per mode, DateRange type, dateLib adapter, modifiers + classNames keys
- [examples.md](references/examples.md) : Single / multiple / range Calendar, DatePicker recipe with PopoverButton trigger, Dutch locale via `date-fns/locale/nl`, disabled-dates with date-fns predicates
- [anti-patterns.md](references/anti-patterns.md) : Five Calendar-level anti-patterns and their recoveries

## Companion Skills

- **shadcn-syntax-popover-tooltip-hovercard** : DatePicker recipe relies on Popover + PopoverTrigger + PopoverContent ; consult for `align`, `side`, controlled open state, and Portal stacking concerns.
- **shadcn-syntax-button** : DatePicker trigger is a `<Button variant="outline">` rendered via `PopoverTrigger asChild` ; consult for `asChild` Slot rules and the variant catalogue.
- **shadcn-errors-react-day-picker-v9** (B13) : Full v8 -> v9 migration playbook : silent breakage signatures, prop rename table, `shadcn add calendar --overwrite` recovery, edge cases in classNames mapping.

## Sources

Verified 2026-05-19 against :

- https://ui.shadcn.com/docs/components/radix/calendar
- https://ui.shadcn.com/docs/components/radix/date-picker
- `apps/v4/registry/new-york-v4/ui/calendar.tsx` (shadcn-ui/ui, default branch)
- `apps/v4/registry/new-york-v4/examples/calendar-demo.tsx`
- `apps/v4/registry/new-york-v4/examples/date-picker-demo.tsx`
- `apps/v4/registry/new-york-v4/examples/date-picker-with-range.tsx`
- `packages/react-day-picker/src/types/shared.ts` (gpbl/react-day-picker, default branch) : `Mode`, `DateRange`, `Matcher` types
- `packages/react-day-picker/src/types/selection.ts` : `SelectedValue<T>`, `SelectHandler<T>`
- https://daypicker.dev/upgrading-v8-to-v10 : v8 -> v9 breaking change list
- shadcn-ui/ui issue #4366 (react-day-picker 9.0.0 release screws up Calendar component, 97 reactions)
