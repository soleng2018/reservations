# shadcn ui : Calendar + DatePicker : Methods Reference

Full prop signatures, types, and adapter shapes for the shadcn Calendar wrapper and the react-day-picker v9 surface it exposes. All types are reproduced verbatim from `packages/react-day-picker/src/types/shared.ts` and `selection.ts` on the gpbl/react-day-picker default branch (verified 2026-05-19).

---

## 1. The Mode union

```ts
export type Mode = "single" | "multiple" | "range";
```

`mode` is **mandatory** in v9. Without it, TypeScript narrows `SelectedValue<T>` to `undefined` and the Calendar will not mark any day as selected even if `selected` is passed a real `Date`.

---

## 2. The DateRange type

```ts
export type DateRange = {
  from: Date | undefined;
  to?: Date | undefined;
};
```

Notes :

- `from` is required but typed `Date | undefined`. The user can clear the range by clicking the start day a second time, so `from` is allowed to be `undefined` even at runtime.
- `to` is optional. Mid-drag the user has chosen `from` but not yet `to`, so `to` is `undefined`. Any rendering of the range label MUST branch on `date?.from` first, THEN on `date.to`.

Import path :

```ts
import { type DateRange } from "react-day-picker"
```

NEVER from `@/components/ui/calendar` : the shadcn wrapper does not re-export the type.

---

## 3. SelectedValue<T> : the conditional selected type

```ts
export type SelectedSingle<T extends { required?: boolean }> =
  T["required"] extends true ? Date : Date | undefined;

export type SelectedMulti<T extends { required?: boolean }> =
  T["required"] extends true ? Date[] : Date[] | undefined;

export type SelectedRange<T extends { required?: boolean }> =
  T["required"] extends true ? DateRange : DateRange | undefined;

export type SelectedValue<T> =
  T extends { mode: "single"; required?: boolean } ? SelectedSingle<T>
  : T extends { mode: "multiple"; required?: boolean } ? SelectedMulti<T>
  : T extends { mode: "range"; required?: boolean } ? SelectedRange<T>
  : undefined;
```

Practical reading :

| mode | required | type of `selected` |
|------|----------|--------------------|
| `"single"` | omitted / `false` | `Date \| undefined` |
| `"single"` | `true` | `Date` |
| `"multiple"` | omitted / `false` | `Date[] \| undefined` |
| `"multiple"` | `true` | `Date[]` |
| `"range"` | omitted / `false` | `DateRange \| undefined` |
| `"range"` | `true` | `DateRange` |

ALWAYS match `useState<T>` to this table exactly. NEVER use `useState<Date>()` when `mode="range"` ; the `setDate` setter will not satisfy the `onSelect` signature.

---

## 4. SelectHandler<T> : the onSelect signatures

```ts
export type SelectHandlerSingle<T extends { required?: boolean | undefined }> =
  (triggerDate: Date,
   modifiers: Modifiers,
   e: React.MouseEvent | React.KeyboardEvent
  ) => T["required"] extends true ? Date : Date | undefined;

export type SelectHandlerMulti<T extends { required?: boolean | undefined }> =
  (triggerDate: Date,
   modifiers: Modifiers,
   e: React.MouseEvent | React.KeyboardEvent
  ) => T["required"] extends true ? Date[] : Date[] | undefined;

export type SelectHandlerRange<T extends { required?: boolean | undefined }> =
  (triggerDate: Date,
   modifiers: Modifiers,
   e: React.MouseEvent | React.KeyboardEvent
  ) => T["required"] extends true ? DateRange : DateRange | undefined;
```

A bare `setDate` (the `useState` setter) is assignable to `onSelect` because TypeScript widens the call to `(value) => void` ; the extra `modifiers` and `e` arguments are ignored. The narrower form with all three arguments is useful when the consumer wants to inspect modifiers (e.g. "was this day flagged `disabled` ?") or capture the originating event.

---

## 5. Calendar prop matrix (shadcn wrapper)

The shadcn wrapper extends `React.ComponentProps<typeof DayPicker>` and adds one extra prop. Verbatim from `apps/v4/registry/new-york-v4/ui/calendar.tsx` :

```ts
function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  captionLayout = "label",
  buttonVariant = "ghost",
  formatters,
  components,
  ...props
}: React.ComponentProps<typeof DayPicker> & {
  buttonVariant?: React.ComponentProps<typeof Button>["variant"]
})
```

| Prop | Type | Default | Purpose |
|------|------|---------|---------|
| `mode` | `"single" \| "multiple" \| "range"` | **none, REQUIRED** | Selection behaviour. Drives `selected` and `onSelect` types. |
| `selected` | `SelectedValue<T>` (see §3) | `undefined` | Currently selected day(s). |
| `onSelect` | `SelectHandler<T>` (see §4) | `undefined` | Callback when the user picks / unpicks a day. |
| `disabled` | `Matcher \| Matcher[]` | `undefined` | Disables days. Matcher = `Date`, `Date[]`, `(d: Date) => boolean`, `{ from, to }`, `{ before }`, `{ after }`, `{ dayOfWeek: number[] }`. |
| `required` | `boolean` | `false` | If `true`, the corresponding `undefined` branch is removed from `selected` / `onSelect`. |
| `min` | `number` | `undefined` | `mode="multiple" \| "range"` only : minimum number of selected days. |
| `max` | `number` | `undefined` | `mode="multiple" \| "range"` only : maximum number of selected days. |
| `numberOfMonths` | `number` | `1` | Renders N months side by side. Canonical range UX is `2`. |
| `defaultMonth` | `Date` | `new Date()` | Initial visible month. ALWAYS set to `selected?.from` for range pickers. |
| `month` | `Date` | `undefined` | Controlled visible month ; pair with `onMonthChange`. |
| `onMonthChange` | `(month: Date) => void` | `undefined` | Controlled visible month callback. |
| `startMonth` | `Date` | `undefined` | Earliest navigable month. **v9 rename of v8's `fromMonth`/`fromYear`.** |
| `endMonth` | `Date` | `undefined` | Latest navigable month. **v9 rename of v8's `toMonth`/`toYear`.** |
| `hidden` | `Matcher \| Matcher[]` | `undefined` | Hides days. **v9 replacement for v8's `fromDate`/`toDate`** : use `hidden={{ before: someDate }}` or `hidden={{ after: someDate }}`. |
| `showOutsideDays` | `boolean` | `true` | Renders days from neighbouring months in the current grid. |
| `captionLayout` | `"label" \| "dropdown" \| "dropdown-months" \| "dropdown-years"` | `"label"` | Month/year navigation. `"dropdown"` shows two selects. |
| `timeZone` | `string` (IANA TZ) | `undefined` | Renders the calendar in the given timezone (e.g. `"Europe/Amsterdam"`). |
| `locale` | `Locale` (from date-fns) | `enUS` | Localises weekday and month labels. Pass `nl` from `date-fns/locale`. |
| `dir` | `"ltr" \| "rtl"` | `"ltr"` | Text direction. |
| `modifiers` | `Record<string, Matcher \| Matcher[]>` | `{}` | Custom day classifiers. |
| `modifiersClassNames` | `Record<string, string>` | `{}` | Tailwind classes applied per matched modifier. |
| `classNames` | `Partial<Record<UI \| DayFlag \| SelectionState \| string, string>>` | shadcn defaults | Per-slot Tailwind override. Keys listed in §7. |
| `className` | `string` | `undefined` | Outer wrapper class. Merged via `cn()`. |
| `formatters` | `Partial<Formatters>` | shadcn override `formatMonthDropdown` | Custom string formatters per label slot. |
| `components` | `Partial<CustomComponents>` | shadcn `Root` + `Chevron` + `DayButton` + `WeekNumber` | Override individual DOM slots. |
| `buttonVariant` | shadcn Button variant | `"ghost"` | shadcn wrapper extra : variant applied to prev/next nav buttons. |
| `dateLib` | `DateLib` | built-in date-fns adapter | Plug a different calendar system (Persian, Hijri, Buddhist, Ethiopic, Hebrew). |

---

## 6. Matcher type (used by `disabled`, `hidden`, `modifiers`)

```ts
export type Matcher =
  | boolean
  | ((date: Date) => boolean)
  | Date
  | Date[]
  | DateRange
  | DateBefore       // { before: Date }
  | DateAfter        // { after: Date }
  | DateInterval     // { before: Date; after: Date } : exclusive both ends
  | DayOfWeek;       // { dayOfWeek: number[] }
```

Examples :

```ts
disabled={[new Date(2026, 11, 25)]}                // single fixed day
disabled={(d) => d < startOfToday()}                // predicate
disabled={{ before: new Date() }}                   // all days before today
disabled={{ after: addDays(new Date(), 30) }}       // beyond +30 days
disabled={{ from: holidayStart, to: holidayEnd }}   // closed range
disabled={{ dayOfWeek: [0, 6] }}                    // weekends (Sun + Sat)
```

NEVER mix two semantically conflicting matcher shapes in one array : `disabled={[someDate, { before: anotherDate }]}` is supported but error-prone. Prefer a single predicate.

---

## 7. classNames keys (from `getDefaultClassNames()`)

The shadcn wrapper calls `getDefaultClassNames()` and merges per-slot Tailwind on top. Every key below is valid in the `classNames` prop :

```
root
months
month
nav
button_previous
button_next
month_caption
dropdowns
dropdown_root
dropdown
caption_label
table             // raw, no defaultClassNames key
weekdays
weekday
week
week_number_header
week_number
day
day_button        // the inner <button> inside each day cell
range_start
range_middle
range_end
today
outside
disabled
hidden
selected          // applied when modifiers.selected is true
```

To extend (NOT replace) the default class, compose with `getDefaultClassNames()` :

```tsx
import { getDefaultClassNames } from "react-day-picker"

const dcn = getDefaultClassNames()
<Calendar
  classNames={{
    today: `${dcn.today} ring-2 ring-amber-500`,
    selected: `${dcn.selected} font-bold`,
  }}
/>
```

NEVER overwrite `classNames.day_button` with a non-shadcn-Button class string : the shadcn wrapper renders the day button via its own `CalendarDayButton` which already calls `<Button variant="ghost" size="icon" />` ; overriding `day_button` will fight the wrapper.

---

## 8. modifiers + modifiersClassNames signature

```ts
modifiers?: Record<string, Matcher | Matcher[]>
modifiersClassNames?: Record<string, string>
```

Convention : key your modifier by intent (`holiday`, `booked`, `available`), then pair the same key in `modifiersClassNames` :

```tsx
<Calendar
  mode="single"
  selected={date}
  onSelect={setDate}
  modifiers={{
    holiday: [new Date(2026, 11, 25), new Date(2026, 11, 26)],
    booked: (d) => bookedSet.has(d.toISOString().slice(0, 10)),
  }}
  modifiersClassNames={{
    holiday: "bg-red-100 text-red-900 font-semibold",
    booked: "line-through opacity-50 pointer-events-none",
  }}
/>
```

The modifier name space is open : `selected`, `disabled`, `today`, `outside`, `hidden`, `range_start`, `range_middle`, `range_end`, `focused` are reserved (set by react-day-picker itself) ; any other key is yours.

---

## 9. components prop (custom slot renderers)

```ts
components?: Partial<CustomComponents>
```

shadcn already overrides four slots in the wrapper :

- `Root` : wraps the calendar in a `<div data-slot="calendar">`
- `Chevron` : renders `ChevronLeftIcon` / `ChevronRightIcon` / `ChevronDownIcon` based on `orientation`
- `DayButton` : uses shadcn `Button` (`variant="ghost"`, `size="icon"`) with `data-range-start`, `data-range-end`, `data-range-middle`, `data-selected-single` attributes
- `WeekNumber` : renders the week-number cell

Override signature for a custom DayButton :

```tsx
import { type DayButton } from "react-day-picker"

function MyDayButton({ day, modifiers, ...props }: React.ComponentProps<typeof DayButton>) {
  return <button {...props} className={modifiers.selected ? "bg-blue-500" : ""} />
}

<Calendar components={{ DayButton: MyDayButton }} ... />
```

Override signature for a custom Chevron :

```tsx
function MyChevron({ orientation, className, ...props }: { orientation?: "left" | "right" | "down"; className?: string }) {
  if (orientation === "left") return <ArrowLeft className={className} {...props} />
  if (orientation === "right") return <ArrowRight className={className} {...props} />
  return <ArrowDown className={className} {...props} />
}
```

---

## 10. dateLib adapter signature

```ts
import { defaultDateLib, type DateLib } from "react-day-picker"

// Custom date library (e.g. luxon, dayjs) :
const myDateLib: DateLib = {
  ...defaultDateLib,
  format: (date, fmt) => luxonFormat(date, fmt),
  addMonths: (date, n) => luxonAddMonths(date, n),
  // ... full DateLib shape : addDays, addMonths, addWeeks, addYears,
  //     differenceInCalendarDays, eachDayOfInterval, endOfMonth, endOfWeek,
  //     format, getMonth, getYear, isAfter, isBefore, isSameDay,
  //     isSameMonth, isSameYear, startOfDay, startOfMonth, startOfWeek
}

<Calendar dateLib={myDateLib} ... />
```

For non-Gregorian calendars use the dedicated entry points :

```tsx
import { Calendar } from "@/components/ui/calendar"          // wrapper
import { DayPicker } from "react-day-picker/persian"          // OR
import { DayPicker } from "react-day-picker/hijri"
import { DayPicker } from "react-day-picker/buddhist"
import { DayPicker } from "react-day-picker/ethiopic"
import { DayPicker } from "react-day-picker/hebrew"
```

ALWAYS use the dedicated entry point for non-Gregorian systems ; passing `locale` alone will localise the labels but NOT the underlying calendar arithmetic.

---

## 11. formatters override

```ts
formatters?: Partial<Formatters>
```

Known keys : `formatCaption`, `formatDay`, `formatMonthDropdown`, `formatMonthCaption`, `formatWeekdayName`, `formatWeekNumber`, `formatYearCaption`, `formatYearDropdown`.

shadcn already overrides `formatMonthDropdown` in the wrapper to use a short month name (`Jan`, `Feb`, ...). The wrapper spreads the consumer's `formatters` AFTER its own, so consumer-supplied entries win :

```tsx
formatters={{
  formatWeekdayName: (d) => d.toLocaleString("nl-NL", { weekday: "short" }),
}}
```

---

## 12. DatePicker recipe signature (no primitive)

There is no `DatePicker` component exported from `@/components/ui/*`. The recipe is documented at https://ui.shadcn.com/docs/components/radix/date-picker and consists of :

```
Popover
  PopoverTrigger (asChild)
    Button (variant="outline")
      CalendarIcon
      {date ? format(date, "PPP") : "Pick a date"}
  PopoverContent (className="w-auto p-0", align="start")
    Calendar (mode="single" | "multiple" | "range")
```

Locked-down patterns documented by shadcn :

| Variant | Identifier | Notes |
|---------|------------|-------|
| Single date | `DatePickerDemo` | `useState<Date \| undefined>()` ; label via `format(d, "PPP")` |
| Date range | `DatePickerWithRange` | `useState<DateRange \| undefined>()` ; label branches on `date?.from` and `date.to` ; `numberOfMonths={2}` |
| With presets | `DatePickerWithPresets` | Adds a Select with "Today / Tomorrow / In a week" inside PopoverContent |
| Date of birth | dropdown captionLayout | `captionLayout="dropdown"` for year + month dropdowns |
| Form integration | RHF + Controller | Pair with `shadcn-syntax-form` Controller + FormField |

---

## Sources

- `apps/v4/registry/new-york-v4/ui/calendar.tsx` (shadcn-ui/ui, default branch, verified 2026-05-19)
- `apps/v4/registry/new-york-v4/examples/calendar-demo.tsx`
- `apps/v4/registry/new-york-v4/examples/date-picker-demo.tsx`
- `apps/v4/registry/new-york-v4/examples/date-picker-with-range.tsx`
- `packages/react-day-picker/src/types/shared.ts` (gpbl/react-day-picker, default branch)
- `packages/react-day-picker/src/types/selection.ts`
- https://ui.shadcn.com/docs/components/radix/calendar
- https://ui.shadcn.com/docs/components/radix/date-picker
- https://daypicker.dev/upgrading-v8-to-v10
