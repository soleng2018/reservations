# react-day-picker v8-in-v9 Anti-Patterns

Six recurring v8-shape-in-v9 failure modes. For each anti-pattern :
symptom, root cause, verified fix, and a reference to the rename
table or shadcn calendar source.

Verified against https://daypicker.dev/v9/upgrading and
https://github.com/shadcn-ui/ui/blob/main/apps/v4/registry/new-york-v4/ui/calendar.tsx
on 2026-05-19.

## AP-01 : `selectedDays` Prop on v9 (Silent Fail)

### Symptom

```tsx
<Calendar selectedDays={date} onSelect={setDate} />
```

The calendar renders. Days are clickable. No day is ever highlighted as
selected. With `strict: true` TypeScript surfaces :

```
Type '{ selectedDays: Date; onSelect: (d: Date) => void; }' is not
assignable to type 'DayPickerProps'.
  Object literal may only specify known properties, and 'selectedDays'
  does not exist in type 'DayPickerProps'.
```

Without strict, the prop is silently dropped and the calendar is
read-only-by-accident.

### Root Cause

v9 renamed `selectedDays` to `selected`. Every shadcn Calendar
example, every blog post, every Claude pre-2024 dataset still uses
`selectedDays`. The rename was the single largest breaking change in
the v9 release.

### Fix

```tsx
<Calendar mode="single" selected={date} onSelect={setDate} />
```

Two parts : (1) rename `selectedDays` -> `selected`. (2) Add the
`mode` prop (REQUIRED in v9 whenever `selected` is set, see AP-02).

NEVER leave `selectedDays` in a v9 code base. The compiler does not
ALWAYS catch it (depending on `tsconfig` strictness) and the symptom
is silent.

## AP-02 : Missing `mode` Prop (TypeScript Error + Silent Selection)

### Symptom

```tsx
<Calendar selected={date} onSelect={setDate} />
```

TypeScript error :

```
Property 'mode' is missing in type '{ selected: Date | undefined;
onSelect: (d: Date | undefined) => void; }' but required in type
'DayPickerProps'.
```

If suppressed with `@ts-ignore`, the calendar renders but clicks never
update `selected`. The picker is uncontrolled internally and the
parent state never sees the change.

### Root Cause

v9 turned `mode` into the discriminator of the `DayPickerProps` union
type. `selected` and `onSelect` have a different shape per mode :

| `mode` | `selected` | `onSelect` |
|--------|------------|------------|
| `"single"` | `Date \| undefined` | `(d: Date \| undefined) => void` |
| `"multiple"` | `Date[] \| undefined` | `(d: Date[] \| undefined) => void` |
| `"range"` | `DateRange \| undefined` | `(r: DateRange \| undefined) => void` |

Without `mode`, TypeScript cannot narrow which `onSelect` you mean,
and the runtime selection algorithm cannot pick which set to maintain.

### Fix

Always set `mode` explicitly :

```tsx
<Calendar mode="single" selected={date} onSelect={setDate} />
```

NEVER suppress the `Property 'mode' is missing` error. The compile
error IS the protection against the silent-no-selection runtime bug.

## AP-03 : `disabledDays` on v9 (Silent Fail)

### Symptom

```tsx
<Calendar
  mode="single"
  selected={date}
  onSelect={setDate}
  disabledDays={[{ before: new Date() }]}
/>
```

Past dates are still clickable. The `disabled` modifier never fires.
TypeScript error (in strict mode) : `disabledDays does not exist on
type DayPickerProps`.

### Root Cause

v9 renamed `disabledDays` -> `disabled`. The new prop accepts the same
`Matcher \| Matcher[]` shape, but the v8 name is no longer recognized.

### Fix

```tsx
<Calendar
  mode="single"
  selected={date}
  onSelect={setDate}
  disabled={[{ before: new Date() }]}
/>
```

`disabled` accepts all `Matcher` shapes : `boolean`, `(d: Date) =>
boolean`, `Date`, `Date[]`, `DateRange`, `{ before }`, `{ after }`,
`{ dayOfWeek: number[] }`. NEVER leave `disabledDays` in a v9 code
base.

## AP-04 : `components.Caption` on v9 (Silent Ignore, Renamed to MonthCaption)

### Symptom

```tsx
<Calendar
  mode="single"
  selected={date}
  onSelect={setDate}
  components={{ Caption: FancyCaption }}
/>
```

The default caption ("May 2026") is shown instead of `FancyCaption`.
No console warning. No TypeScript error (the `components` prop is a
loose `Partial<Components>`).

### Root Cause

v9 renamed `components.Caption` -> `components.MonthCaption`. The
underlying slot also changed signature : it now receives
`{ calendarMonth: CalendarMonth, displayIndex: number }` instead of
`{ displayMonth: Date }`. The v8 component, even if registered under
the right key, will crash on `displayMonth.toLocaleString`.

### Fix

```tsx
import { type MonthCaptionProps } from "react-day-picker"

function FancyMonthCaption({ calendarMonth }: MonthCaptionProps) {
  return <h2>{calendarMonth.date.toLocaleDateString()}</h2>
}

<Calendar
  mode="single"
  selected={date}
  onSelect={setDate}
  components={{ MonthCaption: FancyMonthCaption }}
/>
```

Two changes : (1) rename the key `Caption` -> `MonthCaption`. (2) Update
the destructure from `displayMonth: Date` -> `calendarMonth: CalendarMonth`
(use `calendarMonth.date` for the Date). NEVER assume v8 component
signatures transfer to v9 ; check `references/methods.md` for every
slot.

## AP-05 : `modifiers` as Array on v9 (Expects Object of Matchers)

### Symptom

```tsx
<Calendar
  mode="single"
  selected={date}
  onSelect={setDate}
  modifiers={[
    { dayOfWeek: [0, 6] },
    new Date(2026, 5, 15),
  ]}
  modifiersClassNames={{ weekend: "bg-orange-200" }}
/>
```

No day is ever highlighted. `onDayClick` receives a `modifiers`
argument with NO keys from the array. TypeScript error (strict) :
`Type '({ dayOfWeek: number[] } | Date)[]' is not assignable to type
'Record<string, Matcher | Matcher[]>'`.

### Root Cause

v8 accepted a flat array of Matchers and used an implicit naming
convention. v9 requires an OBJECT, where each key is the modifier
name (used by `modifiersClassNames`, `modifiersStyles`, and surfaced
to `onDayClick`'s `modifiers` argument) :

```ts
modifiers: Record<string, Matcher | Matcher[]>
```

### Fix

```tsx
<Calendar
  mode="single"
  selected={date}
  onSelect={setDate}
  modifiers={{
    weekend: { dayOfWeek: [0, 6] },
    booked: new Date(2026, 5, 15),
  }}
  modifiersClassNames={{
    weekend: "bg-orange-200",
    booked: "bg-red-200",
  }}
/>
```

The key in `modifiers` MUST match the key in `modifiersClassNames` /
`modifiersStyles`. ALWAYS use the object form on v9.

## AP-06 : `classNames` with v8 Keys (CSS Classes Don't Match)

### Symptom

```tsx
<Calendar
  mode="single"
  selected={date}
  onSelect={setDate}
  classNames={{
    cell: "h-9 w-9",
    day: "rounded-md hover:bg-accent",
    day_selected: "bg-primary text-primary-foreground",
    head_row: "flex",
    nav_button: "h-7 w-7",
    caption: "text-lg font-semibold",
  }}
/>
```

Every utility class is silently dropped. The calendar renders with
the unstyled v9 defaults. No console warning.

### Root Cause

v9 rekeyed `classNames` to the `UI` enum :

| v8 key | v9 key |
|--------|--------|
| `cell` | `day` (the `<td>`) |
| `day` | `day_button` (the `<button>` inside the cell) |
| `day_selected` | `selected` (a modifier) |
| `day_disabled` | `disabled` (a modifier) |
| `day_today` | `today` (a modifier) |
| `day_range_start` | `range_start` |
| `day_range_middle` | `range_middle` |
| `day_range_end` | `range_end` |
| `head_row` | `weekdays` |
| `row` | `week` |
| `nav_button` | `button_previous` / `button_next` |
| `caption` | `month_caption` |
| `caption_label` | `caption_label` (unchanged) |

The v8 keys do NOT match any v9 slot and are silently dropped.

### Fix

```tsx
import { DayPicker, getDefaultClassNames } from "react-day-picker"
import { cn } from "@/lib/utils"

const defaultClassNames = getDefaultClassNames()

<DayPicker
  mode="single"
  selected={date}
  onSelect={setDate}
  classNames={{
    day: cn("h-9 w-9", defaultClassNames.day),
    day_button: cn("rounded-md hover:bg-accent", defaultClassNames.day_button),
    selected: cn("bg-primary text-primary-foreground", defaultClassNames.selected),
    weekdays: cn("flex", defaultClassNames.weekdays),
    button_previous: cn("h-7 w-7", defaultClassNames.button_previous),
    button_next: cn("h-7 w-7", defaultClassNames.button_next),
    month_caption: cn("text-lg font-semibold", defaultClassNames.month_caption),
  }}
/>
```

ALWAYS merge with `getDefaultClassNames()` so the unstyled-DayPicker
defaults stay applied alongside your Tailwind utilities. The shadcn
Calendar source does this on every key (see calendar.tsx).

If the shadcn-side `components/ui/calendar.tsx` itself uses v8 keys
(`cell`, `day_selected`, etc.), the file pre-dates v9. Run :

```bash
npx shadcn@latest add calendar --overwrite
```

This regenerates the file with v9 keys and `getDefaultClassNames()`
wiring in one shot. NEVER hand-patch a v8 calendar.tsx file ; the
rename surface is too wide.

## Cross-Reference

For the full v8 -> v9 rename table see `references/methods.md`. For
side-by-side migration examples of every pattern above see
`references/examples.md`. For the green-field v9 syntax (not a
migration) see the companion skill `shadcn-syntax-calendar-datepicker`
(Batch B7).
