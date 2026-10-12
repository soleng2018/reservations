# react-day-picker v8 -> v9 API Reference

Definitive rename table, `UI` enum, `DateLib` adapter signature, and
components override map. Verified against
https://daypicker.dev/v9/upgrading and the shadcn Calendar source at
https://github.com/shadcn-ui/ui/blob/main/apps/v4/registry/new-york-v4/ui/calendar.tsx
on 2026-05-19.

## 1. Full v8 -> v9 Prop / API Rename Table

| v8 name | v9 name | Kind | Notes |
|---------|---------|------|-------|
| `selectedDays` | `selected` | prop | Type narrowed by `mode` (`Date \| Date[] \| DateRange`) |
| `onSelect` | `onSelect` | prop | Signature narrowed by `mode` |
| `disabledDays` | `disabled` | prop | `Matcher \| Matcher[]` |
| `modifiers` (array) | `modifiers` (object of Matchers) | prop | `{ name: Matcher }` ; key is the modifier name |
| `modifiersStyles` | `modifiersStyles` | prop | Same shape, keys map to v9 modifier names |
| `modifiersClassNames` | `modifiersClassNames` | prop | Same shape, keys map to v9 modifier names |
| `fromMonth` | `startMonth` | prop | `Date` |
| `toMonth` | `endMonth` | prop | `Date` |
| `fromDate` | `startMonth` + `hidden` | prop | Use `hidden={{ before: Date }}` |
| `toDate` | `endMonth` + `hidden` | prop | Use `hidden={{ after: Date }}` |
| `month` | `month` | prop | unchanged (controlled current month) |
| `defaultMonth` | `defaultMonth` | prop | unchanged (uncontrolled initial month) |
| `numberOfMonths` | `numberOfMonths` | prop | unchanged |
| `showOutsideDays` | `showOutsideDays` | prop | unchanged |
| `showWeekNumber` | `showWeekNumber` | prop | unchanged |
| `weekStartsOn` | `weekStartsOn` | prop | unchanged (`0..6`) |
| `ISOWeek` | `ISOWeek` | prop | unchanged |
| `locale` | `locale` | prop | Now forwarded to `dateLib` ; type narrowed to the adapter |
| (no `mode`) | `mode="single" \| "multiple" \| "range"` | prop | REQUIRED whenever `selected` is used |
| `Caption` (custom component) | `MonthCaption` | components | renamed |
| `IconLeft` (custom component) | `Chevron` with `orientation="left"` | components | merged |
| `IconRight` (custom component) | `Chevron` with `orientation="right"` | components | merged |
| `Row` | `Week` | components | renamed |
| `HeadRow` | `Weekdays` | components | renamed |
| `Day` | `DayButton` | components | signature changed to `({ day, modifiers, ...props })` |
| `Head` | `Weekdays` (header) + `Weekday` (cell) | components | split |
| `DayContent` | inline JSX inside `DayButton` | components | removed |
| `formatCaption: (m) => JSX` | `formatCaption: (m) => string` | formatters | MUST return string ; for JSX use `components.MonthCaption` |
| `formatDay: (d) => JSX` | `formatDay: (d) => string` | formatters | MUST return string |
| direct `date-fns` import | `dateLib` adapter prop | infra | Pass a `DateLib` so locales / time-zones / week-starts flow through the picker |
| `useNavigation` hook | `useDayPicker` hook | hooks | renamed |
| `react-day-picker/dist/style.css` | `react-day-picker/style.css` | CSS | path moved |
| `DayPickerSingleProps` | `PropsSingle` | TS type | renamed |
| `DayPickerMultipleProps` | `PropsMulti` | TS type | renamed |
| `DayPickerRangeProps` | `PropsRange` | TS type | renamed |
| `DayPickerProps` | `DayPickerProps` | TS type | retained as the union of all three |
| `Matcher` | `Matcher` | TS type | unchanged shape (`Date \| Date[] \| DateRange \| DayOfWeek \| Predicate`) |

## 2. The `mode` Discriminator

The `mode` prop discriminates the union type of `selected` / `onSelect`.
Mode determines the runtime selection algorithm AND the TypeScript shape :

| `mode` value | `selected` type | `onSelect` signature |
|--------------|-----------------|----------------------|
| `"single"` | `Date \| undefined` | `(date: Date \| undefined, triggered: Date, modifiers: Modifiers, e: React.MouseEvent) => void` |
| `"multiple"` | `Date[] \| undefined` | `(dates: Date[] \| undefined, triggered: Date, modifiers: Modifiers, e: React.MouseEvent) => void` |
| `"range"` | `DateRange \| undefined` | `(range: DateRange \| undefined, triggered: Date, modifiers: Modifiers, e: React.MouseEvent) => void` |
| omitted | NOT VALID with `selected` | TypeScript error : Property 'mode' is missing |

`DateRange` is `{ from: Date \| undefined; to?: Date \| undefined }`.

## 3. The `UI` Enum (`classNames` keys)

`classNames` is keyed by `UI` enum string values. Use
`getDefaultClassNames()` to pull the v9 defaults and merge with `cn(...)`.
The full key list (verified against the shadcn Calendar source) :

| UI key | Element |
|--------|---------|
| `root` | the outer `<div>` rendered by DayPicker |
| `months` | the wrapper around all `month` blocks |
| `month` | one calendar month block (caption + grid) |
| `nav` | the prev / next navigation row |
| `button_previous` | the previous-month button |
| `button_next` | the next-month button |
| `month_caption` | the caption above the grid (replaces v8 `caption`) |
| `dropdowns` | the dropdown row (used when `captionLayout="dropdown"`) |
| `dropdown_root` | dropdown wrapper |
| `dropdown` | the actual `<select>` |
| `caption_label` | the textual caption label |
| `table` | the `<table>` |
| `weekdays` | the header row of weekday names (replaces v8 `head_row`) |
| `weekday` | one weekday cell |
| `week` | one row of days (replaces v8 `row`) |
| `week_number` | week-number cell |
| `week_number_header` | week-number header cell |
| `day` | one day cell (the `<td>`) ; replaces v8 `cell` |
| `day_button` | the `<button>` INSIDE the day cell ; replaces v8 `day` |
| `range_start` | day at the start of a range (when `mode="range"`) |
| `range_middle` | day inside a range |
| `range_end` | day at the end of a range |
| `today` | the day marked as today |
| `outside` | day from the previous / next month (when `showOutsideDays`) |
| `disabled` | day matched by the `disabled` matcher |
| `hidden` | day matched by the `hidden` matcher |
| `selected` | day that is in the `selected` set |
| `focused` | day that has keyboard focus |

The v8 keys `cell`, `caption`, `head_row`, `nav_button`, `day_selected`,
`day_disabled`, `day_outside`, `day_today`, `day_range_start`,
`day_range_middle`, `day_range_end`, `day_hidden` are NO LONGER MATCHED
by any element. Passing them in `classNames` is silently ignored.

`getDefaultClassNames()` returns a `Record<UI, string>` of v9 defaults
used by the unstyled DayPicker. Merge with `cn(...)` to keep the
defaults AND apply Tailwind utilities.

## 4. The `DateLib` Adapter

```ts
import { DayPicker, defaultDateLib, type DateLib } from "react-day-picker"
```

`DateLib` is a structural type with these methods (subset used by the
picker) :

| Method | Purpose |
|--------|---------|
| `addDays(date, n)` | add `n` days |
| `addMonths(date, n)` | add `n` months |
| `differenceInCalendarDays(a, b)` | day delta |
| `endOfMonth(date)` | last day of month |
| `endOfWeek(date)` | last day of week |
| `format(date, fmt)` | format to string ; uses `locale` |
| `isAfter(a, b)` | comparison |
| `isBefore(a, b)` | comparison |
| `isSameDay(a, b)` | comparison |
| `isSameMonth(a, b)` | comparison |
| `isSameYear(a, b)` | comparison |
| `setMonth(date, m)` | set month |
| `setYear(date, y)` | set year |
| `startOfDay(date)` | start of day |
| `startOfMonth(date)` | first day of month |
| `startOfWeek(date)` | first day of week |
| `timeZone?: string` | when set, all operations run in this IANA zone |
| `weekStartsOn?: 0..6` | week-start override |

The default adapter wraps `date-fns`. To pass a locale :

```ts
import { fr } from "date-fns/locale"
<DayPicker locale={fr} />  // shorthand : forwarded to defaultDateLib
```

To pass a time-zone (Browser `Intl` adapter is the v9 reference) :

```ts
import { defaultDateLib, DayPicker } from "react-day-picker"
<DayPicker dateLib={{ ...defaultDateLib, timeZone: "Europe/Amsterdam" }} />
```

## 5. The `Matcher` Type

`Matcher` is unchanged from v8 in shape. It is the type of `disabled`,
`hidden`, modifier values, and `selected` for `mode="multiple"` :

```ts
type Matcher =
  | boolean
  | ((date: Date) => boolean)
  | Date
  | Date[]
  | DateRange                       // { from, to }
  | DayOfWeek                       // { dayOfWeek: number[] }
  | DateBefore                      // { before: Date }
  | DateAfter                       // { after: Date }
  | DateInterval                    // { before, after }
```

Apply MULTIPLE matchers by passing an array : `disabled={[matcher1, matcher2]}`.

## 6. The `components` Override Map

Every visual slot can be replaced by a custom component. v9 uses these
keys (v8 keys in parentheses if renamed) :

| Key | Purpose | v8 name (if different) |
|-----|---------|------------------------|
| `Root` | outer container | `Root` |
| `Months` | wrapper around months | `Months` |
| `Month` | one month block | `Month` |
| `MonthCaption` | caption above the grid | `Caption` |
| `Nav` | navigation row | `Nav` |
| `PreviousMonthButton` | prev button | `Navigation` (merged) |
| `NextMonthButton` | next button | `Navigation` (merged) |
| `Chevron` | left / right / up / down icon | `IconLeft` / `IconRight` (merged) |
| `Dropdown` | month / year dropdown | `Dropdown` |
| `Weekdays` | header row | `HeadRow` |
| `Weekday` | one weekday cell | `Head` (cell) |
| `Week` | one row of days | `Row` |
| `Day` | day `<td>` wrapper | `Day` (kept name, NEW signature) |
| `DayButton` | day `<button>` | `Day` (the inner button) |
| `WeekNumber` | week-number cell | `WeekNumber` |

`DayButton` signature in v9 :

```ts
type DayButtonProps = {
  day: CalendarDay              // { date: Date, displayMonth: Date, dateLib, ... }
  modifiers: Modifiers          // { selected, disabled, today, outside, focused, ... }
} & React.ButtonHTMLAttributes<HTMLButtonElement>
```

`day.date` is the `Date` object. `modifiers.focused` is the prop the
shadcn `CalendarDayButton` uses to call `ref.current?.focus()`.

`Chevron` signature in v9 :

```ts
type ChevronProps = {
  orientation: "left" | "right" | "up" | "down"
  className?: string
  size?: number
  disabled?: boolean
}
```

## 7. The Formatter Contract

`formatters` is an object of optional functions that produce STRINGS
(NOT JSX) from `Date` inputs. The v9 keys :

| Formatter | Input | Output |
|-----------|-------|--------|
| `formatCaption` | `Date` | `string` |
| `formatDay` | `Date` | `string` |
| `formatWeekNumber` | `number` | `string` |
| `formatWeekdayName` | `Date` | `string` |
| `formatMonthDropdown` | `Date` | `string` |
| `formatYearDropdown` | `Date` | `string` |

For JSX (icons, badges, formatting wrappers) inside a slot, use the
`components` override instead. Returning JSX from a formatter throws
"Objects are not valid as a React child".

## 8. Hooks

| v8 hook | v9 hook | Purpose |
|---------|---------|---------|
| `useNavigation` | `useDayPicker` | read current month, goToMonth, etc. |
| `useDayRender` | `useDayPicker` | merged into the same hook |

The unified `useDayPicker` returns an object with `goToMonth`,
`goToDate`, `nextMonth`, `previousMonth`, `months`, `dayPickerProps`,
`selected`, etc.

## 9. Verification Sources

- https://daypicker.dev/v9/upgrading (2026-05-19)
- https://daypicker.dev/v9/guides/custom-modifiers (2026-05-19)
- https://github.com/shadcn-ui/ui/blob/main/apps/v4/registry/new-york-v4/ui/calendar.tsx
  (2026-05-19) : the canonical shadcn v9 Calendar wiring
- https://github.com/shadcn-ui/ui/issues/4366 (2026-05-19)
