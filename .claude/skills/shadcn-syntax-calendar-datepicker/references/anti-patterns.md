# shadcn ui : Calendar + DatePicker : Anti-Patterns

Five recurring failure modes, observed in shadcn-ui/ui GitHub issues (notably #4366) and in real react-day-picker v9 migrations. Each entry shows the broken code, the diagnosis, and the corrected form.

---

## Anti-Pattern 1 : Omitting the `mode` prop in v9

### Broken

```tsx
"use client"
import * as React from "react"
import { Calendar } from "@/components/ui/calendar"

export function MyDatePicker() {
  const [date, setDate] = React.useState<Date | undefined>(new Date())

  return (
    <Calendar selected={date} onSelect={setDate} />
  )
}
```

### Symptom

Calendar renders. No day is ever marked selected, no matter what `date` contains. `onSelect` is never called. TypeScript may not complain because `SelectedValue<T>` falls through to `undefined` when `mode` is absent.

### Diagnosis

react-day-picker v9 made `mode` mandatory. Without it, the conditional type `SelectedValue<T>` matches none of the `mode: "single" | "multiple" | "range"` branches and degrades to `undefined`. The component then ignores any `selected` value because internally it has no notion of how to interpret it (single date ? array ? range object ?).

This is the v9 break that drove issue #4366 (97 reactions). In v8, omitting `mode` defaulted to single-selection behaviour. In v9, omitting `mode` means "I don't want selection at all."

### Fix

ALWAYS pass `mode` explicitly. There is no default :

```tsx
<Calendar mode="single" selected={date} onSelect={setDate} />
```

NEVER rely on a "single is default" mental model carried over from v8 ; that contract was removed.

---

## Anti-Pattern 2 : v8 prop names on a v9 Calendar

### Broken

```tsx
"use client"
import { Calendar } from "@/components/ui/calendar"

<Calendar
  selectedDays={date}            // v8
  onDayClick={handleClick}        // v8 callback name
  disabledDays={pastDates}        // v8
  fromMonth={new Date(2020, 0)}   // v8
  toMonth={new Date(2030, 11)}    // v8
  fromDate={startOfToday()}       // v8
/>
```

### Symptom

TypeScript errors on every renamed prop ("`Property 'selectedDays' does not exist on type ...`"). The Calendar renders but ignores every v8 prop. Disabled days are not disabled, navigation bounds are not enforced.

### Diagnosis

Mid-2025 react-day-picker v9 renamed and consolidated the prop surface. The migration table :

| v8 | v9 |
|----|----|
| `selectedDays` | `selected` |
| `onDayClick` | `onSelect` |
| `disabledDays` | `disabled` |
| `fromMonth` / `fromYear` | `startMonth` |
| `toMonth` / `toYear` | `endMonth` |
| `fromDate` | `hidden={{ before: someDate }}` |
| `toDate` | `hidden={{ after: someDate }}` |

This is the same migration documented at https://daypicker.dev/upgrading-v8-to-v10 (v8 -> v9 -> v10).

### Fix

Rename every v8 prop. For `fromDate` / `toDate`, the replacement is the `hidden` prop with a before/after matcher :

```tsx
<Calendar
  mode="single"
  selected={date}
  onSelect={setDate}
  disabled={pastDates}
  startMonth={new Date(2020, 0)}
  endMonth={new Date(2030, 11)}
  hidden={{ before: startOfToday() }}
/>
```

If the project's `components/ui/calendar.tsx` still uses v8 internal class names (`day_selected`, `day_disabled`, `cell`, `Caption`, `Row`), the wrapper itself is stale. Re-pull it :

```bash
pnpm dlx shadcn@latest add calendar --overwrite
```

NEVER hand-patch the v8 wrapper to satisfy v9 ; the registry version is canonical.

---

## Anti-Pattern 3 : `useState<Date>()` for `mode="range"`

### Broken

```tsx
"use client"
import * as React from "react"
import { Calendar } from "@/components/ui/calendar"

export function BadRangePicker() {
  const [date, setDate] = React.useState<Date | undefined>()

  return (
    <Calendar
      mode="range"
      selected={date}            // type error : DateRange expected
      onSelect={setDate}          // type error : DateRange setter expected
      numberOfMonths={2}
    />
  )
}
```

### Symptom

TypeScript error : `Type 'Date | undefined' is not assignable to type 'DateRange | undefined'`. If the consumer silences the error with `as any`, the runtime behaviour is worse : the Calendar attempts to read `selected.from` and crashes with `Cannot read properties of undefined (reading 'from')`.

### Diagnosis

`mode="range"` flips the `SelectedValue<T>` conditional to `SelectedRange<T> = DateRange | undefined`. A `Date | undefined` setter does not satisfy `SelectHandlerRange<T>`. The two type universes do not overlap.

### Fix

Type the state to match the mode :

```tsx
import { type DateRange } from "react-day-picker"

const [range, setRange] = React.useState<DateRange | undefined>()

<Calendar
  mode="range"
  selected={range}
  onSelect={setRange}
  numberOfMonths={2}
/>
```

ALWAYS import `DateRange` from `react-day-picker` (NEVER from `@/components/ui/calendar` ; the wrapper does not re-export it). ALWAYS type single-mode state as `Date | undefined`, multiple-mode state as `Date[] | undefined`, range-mode state as `DateRange | undefined`. Mixing modes and state shapes is the #1 silent bug in DatePicker rollouts.

---

## Anti-Pattern 4 : Missing `"use client"` in a Next.js App Router page

### Broken

```tsx
// app/booking/page.tsx
// (no "use client" directive)

import { Calendar } from "@/components/ui/calendar"

export default function BookingPage() {
  return <Calendar mode="single" selected={new Date()} onSelect={() => {}} />
}
```

### Symptom

Next.js build error : `You're importing a component that needs useState. It only works in a Client Component but none of its parents are marked with "use client", so they're Server Components by default.` OR the page renders but the React hydration produces a warning : `Hydration failed because the initial UI does not match what was rendered on the server.`

### Diagnosis

The shadcn Calendar wrapper file starts with `"use client"` itself, AND it calls `Intl.DateTimeFormat()` internally to format month names. When the file that mounts the Calendar is a Server Component, the parent is server-rendered but the child is client-rendered. Time-zone differences between the Node server and the browser produce a hydration mismatch.

### Fix

Prefix the parent file with `"use client"` :

```tsx
"use client"

import * as React from "react"
import { Calendar } from "@/components/ui/calendar"

export default function BookingPage() {
  const [date, setDate] = React.useState<Date | undefined>(new Date())
  return <Calendar mode="single" selected={date} onSelect={setDate} />
}
```

If the surrounding page MUST stay server-rendered (SEO, streaming), split it : keep the page as a Server Component, extract the date-picking surface into a child `"use client"` component, and render the child from the page.

NEVER initialise `useState(new Date())` outside `"use client"` ; that alone causes the hydration mismatch even before Calendar mounts.

---

## Anti-Pattern 5 : Hand-styling individual day cells with arbitrary Tailwind

### Broken

```tsx
"use client"
import { Calendar } from "@/components/ui/calendar"

// Some weeks earlier : the team patched components/ui/calendar.tsx
// to make Sundays red by editing the JSX directly :
//
//   <DayPicker
//     ...
//     components={{
//       DayButton: ({ day, ...props }) => (
//         <button
//           {...props}
//           className={
//             day.date.getDay() === 0
//               ? "bg-red-100 text-red-700"
//               : ""
//           }
//         />
//       ),
//     }}
//   />

<Calendar mode="single" selected={date} onSelect={setDate} />
```

### Symptom

Sundays look right today. The next `shadcn add calendar --overwrite` (or a teammate running `shadcn migrate radix`) silently reverts `components/ui/calendar.tsx` and Sundays go back to normal styling. No one notices for two weeks.

### Diagnosis

shadcn's ownership model says "we copy the source, you edit it." But editing the source means every future registry pull risks blowing the customisation away. The hand-rolled DayButton override also bypasses the shadcn wrapper's own range-start / range-end / range-middle / selected-single data attributes, so a future `mode="range"` use will misrender the bar styling.

### Fix

ALWAYS route semantic-day styling through `modifiers` + `modifiersClassNames`, NOT through patches to `calendar.tsx` :

```tsx
<Calendar
  mode="single"
  selected={date}
  onSelect={setDate}
  modifiers={{ sunday: (d) => d.getDay() === 0 }}
  modifiersClassNames={{ sunday: "bg-red-100 text-red-700" }}
/>
```

ALWAYS route structural-slot styling through the `classNames` prop with keys exposed by `getDefaultClassNames()` (`button_previous`, `weekday`, `today`, `selected`, `disabled`, etc.). NEVER edit `components/ui/calendar.tsx` for things that the prop surface already supports.

When the prop surface genuinely cannot express the customisation (custom DOM, not just custom class), use `components={{ DayButton: ... }}` at the consumer site, NOT inside `calendar.tsx`. The override stays in user code and survives every `shadcn add --overwrite`.

---

## Cross-references

- `shadcn-errors-react-day-picker-v9` (B13) : Full v8 -> v9 migration playbook, silent breakage signatures, recovery flow for each renamed prop and class name.
- `shadcn-syntax-popover-tooltip-hovercard` : DatePicker recipe relies on Popover ; consult for `align`, `side`, controlled open state.
- `shadcn-syntax-button` : DatePicker trigger uses `<Button variant="outline">` with `asChild` on `PopoverTrigger` ; consult for the Slot child-count rule and the variant catalogue.
- `shadcn-syntax-form` : Calendar inside a react-hook-form requires `Controller`, never `register` ; the FormField pattern wraps Controller with FormItem / FormLabel / FormDescription / FormMessage.

## Sources

- shadcn-ui/ui issue #4366 (97 reactions) : "react-day-picker 9.0.0 release screws up Calendar component"
- https://daypicker.dev/upgrading-v8-to-v10
- `apps/v4/registry/new-york-v4/ui/calendar.tsx`
- `packages/react-day-picker/src/types/selection.ts`
