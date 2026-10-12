# react-day-picker v8 -> v9 Code Migration Examples

Side-by-side v8 -> v9 conversions for the six recurring patterns inside
a shadcn `Calendar`. Each block is a complete, copy-pastable component.
Verified against https://daypicker.dev/v9/upgrading and the shadcn
Calendar source on 2026-05-19.

## 1. Single-Date Selection

### v8 (broken on v9)

```tsx
"use client"
import * as React from "react"
import { Calendar } from "@/components/ui/calendar"

export function SingleDatePicker() {
  const [date, setDate] = React.useState<Date | undefined>(new Date())
  return (
    <Calendar
      selectedDays={date}
      onSelect={setDate}
    />
  )
}
```

Symptoms on v9 : the calendar renders ; clicking a day does nothing ;
TypeScript error : `selectedDays does not exist on type DayPickerProps`.

### v9 (correct)

```tsx
"use client"
import * as React from "react"
import { Calendar } from "@/components/ui/calendar"

export function SingleDatePicker() {
  const [date, setDate] = React.useState<Date | undefined>(new Date())
  return (
    <Calendar
      mode="single"
      selected={date}
      onSelect={setDate}
      className="rounded-md border"
    />
  )
}
```

Two changes : `selectedDays` -> `selected` ; ADD `mode="single"`.

## 2. Range Selection with `DateRange`

### v8 (broken on v9)

```tsx
"use client"
import * as React from "react"
import { Calendar } from "@/components/ui/calendar"
import { DateRange } from "react-day-picker"

export function RangeDatePicker() {
  const [range, setRange] = React.useState<DateRange | undefined>()
  return (
    <Calendar
      selectedDays={range}     // v8 prop
      onSelect={setRange}
      numberOfMonths={2}
    />
  )
}
```

Symptoms on v9 : TypeScript error ; even if cast, range selection
ignores clicks because `mode` is missing.

### v9 (correct)

```tsx
"use client"
import * as React from "react"
import { Calendar } from "@/components/ui/calendar"
import { type DateRange } from "react-day-picker"

export function RangeDatePicker() {
  const [range, setRange] = React.useState<DateRange | undefined>({
    from: new Date(),
    to: undefined,
  })
  return (
    <Calendar
      mode="range"
      selected={range}
      onSelect={setRange}
      numberOfMonths={2}
      className="rounded-md border"
    />
  )
}
```

Three changes : `selectedDays` -> `selected` ; ADD `mode="range"` ;
import `type DateRange` (type-only).

## 3. Disabled Days

### v8 (broken on v9)

```tsx
"use client"
import * as React from "react"
import { Calendar } from "@/components/ui/calendar"

export function NoWeekendsCalendar() {
  const [date, setDate] = React.useState<Date | undefined>()
  return (
    <Calendar
      selectedDays={date}
      onSelect={setDate}
      disabledDays={(d) => d.getDay() === 0 || d.getDay() === 6}   // v8 prop
    />
  )
}
```

Symptoms on v9 : weekends are still clickable ; TypeScript error :
`disabledDays does not exist on type DayPickerProps`.

### v9 (correct)

```tsx
"use client"
import * as React from "react"
import { Calendar } from "@/components/ui/calendar"

export function NoWeekendsCalendar() {
  const [date, setDate] = React.useState<Date | undefined>()
  return (
    <Calendar
      mode="single"
      selected={date}
      onSelect={setDate}
      disabled={(d) => d.getDay() === 0 || d.getDay() === 6}
    />
  )
}
```

Three changes : `selectedDays` -> `selected` ; `disabledDays` ->
`disabled` ; ADD `mode="single"`.

Disabled accepts the full `Matcher` shape (boolean, predicate, Date,
Date[], DateRange, `{ before }`, `{ after }`, `{ dayOfWeek }`).

## 4. Custom Caption : `Caption` -> `MonthCaption`

### v8 (broken on v9)

```tsx
"use client"
import * as React from "react"
import { Calendar } from "@/components/ui/calendar"
import { format } from "date-fns"

function FancyCaption({ displayMonth }: { displayMonth: Date }) {
  return (
    <h2 className="text-lg font-semibold">
      {format(displayMonth, "MMMM yyyy")}
    </h2>
  )
}

export function CalendarWithCustomCaption() {
  const [date, setDate] = React.useState<Date | undefined>()
  return (
    <Calendar
      selectedDays={date}
      onSelect={setDate}
      components={{ Caption: FancyCaption }}   // v8 key
    />
  )
}
```

Symptoms on v9 : `FancyCaption` never renders ; the default caption is
shown ; no error in the console (silent miss).

### v9 (correct)

```tsx
"use client"
import * as React from "react"
import { Calendar } from "@/components/ui/calendar"
import { format } from "date-fns"
import { type MonthCaptionProps } from "react-day-picker"

function FancyMonthCaption({ calendarMonth }: MonthCaptionProps) {
  return (
    <h2 className="text-lg font-semibold">
      {format(calendarMonth.date, "MMMM yyyy")}
    </h2>
  )
}

export function CalendarWithCustomCaption() {
  const [date, setDate] = React.useState<Date | undefined>()
  return (
    <Calendar
      mode="single"
      selected={date}
      onSelect={setDate}
      components={{ MonthCaption: FancyMonthCaption }}
    />
  )
}
```

Three changes : `Caption` -> `MonthCaption` (both as the
`components` key and the type name) ; the prop is `calendarMonth`
(an object with `.date`), not `displayMonth: Date` ; ADD `mode`.

## 5. Modifiers : Array -> Object of Matchers

### v8 (broken on v9)

```tsx
"use client"
import * as React from "react"
import { Calendar } from "@/components/ui/calendar"

export function CalendarWithBookedDays() {
  const [date, setDate] = React.useState<Date | undefined>()
  const booked = [
    new Date(2026, 5, 8),
    new Date(2026, 5, 9),
    { from: new Date(2026, 5, 15), to: new Date(2026, 5, 20) },
  ]
  return (
    <Calendar
      selectedDays={date}
      onSelect={setDate}
      modifiers={booked}                                          // v8 : flat array
      modifiersClassNames={{ booked: "bg-orange-200" }}
    />
  )
}
```

Symptoms on v9 : the orange highlight never appears ; no console
error ; `modifiers.booked` is `undefined` inside `onDayClick`.

### v9 (correct)

```tsx
"use client"
import * as React from "react"
import { Calendar } from "@/components/ui/calendar"

export function CalendarWithBookedDays() {
  const [date, setDate] = React.useState<Date | undefined>()
  return (
    <Calendar
      mode="single"
      selected={date}
      onSelect={setDate}
      modifiers={{
        booked: [
          new Date(2026, 5, 8),
          new Date(2026, 5, 9),
          { from: new Date(2026, 5, 15), to: new Date(2026, 5, 20) },
        ],
      }}
      modifiersClassNames={{ booked: "bg-orange-200" }}
    />
  )
}
```

The shape is `modifiers={{ <name>: Matcher | Matcher[] }}`. The
`<name>` key is what surfaces in `onDayClick`'s `modifiers` argument
and what `modifiersClassNames` keys against.

## 6. `dateLib` with a Custom Locale and Time-Zone

### v8 (broken on v9)

```tsx
"use client"
import * as React from "react"
import { Calendar } from "@/components/ui/calendar"
import { fr } from "date-fns/locale"
import { format } from "date-fns"

export function FrenchCalendar() {
  const [date, setDate] = React.useState<Date | undefined>()
  return (
    <Calendar
      selectedDays={date}
      onSelect={setDate}
      locale={fr}
      formatCaption={(m) => <strong>{format(m, "LLLL yyyy", { locale: fr })}</strong>}
    />
  )
}
```

Symptoms on v9 : `formatCaption` throws `Objects are not valid as a
React child` because it returns JSX, not a string.

### v9 (correct, locale only)

```tsx
"use client"
import * as React from "react"
import { Calendar } from "@/components/ui/calendar"
import { fr } from "date-fns/locale"

export function FrenchCalendar() {
  const [date, setDate] = React.useState<Date | undefined>()
  return (
    <Calendar
      mode="single"
      selected={date}
      onSelect={setDate}
      locale={fr}
    />
  )
}
```

### v9 (correct, with time-zone via `dateLib`)

```tsx
"use client"
import * as React from "react"
import { Calendar } from "@/components/ui/calendar"
import { fr } from "date-fns/locale"
import { defaultDateLib } from "react-day-picker"

export function AmsterdamCalendar() {
  const [date, setDate] = React.useState<Date | undefined>()
  return (
    <Calendar
      mode="single"
      selected={date}
      onSelect={setDate}
      locale={fr}
      dateLib={{ ...defaultDateLib, timeZone: "Europe/Amsterdam" }}
    />
  )
}
```

To bold the caption in v9, use a custom `components.MonthCaption`
(see example 4) ; formatters MUST return strings.

## 7. CSS Import Path

### v8

```tsx
import "react-day-picker/dist/style.css"
```

### v9

```tsx
import "react-day-picker/style.css"
```

Note : the shadcn `components/ui/calendar.tsx` does NOT import the
react-day-picker stylesheet directly. It applies every class via
`classNames` + `getDefaultClassNames()`. The import-path issue only
appears in apps that ALSO import the raw react-day-picker stylesheet
(common when DayPicker is used outside the shadcn Calendar wrapper).

## 8. Boundary Props : `fromMonth` / `toMonth` -> `startMonth` / `endMonth`

### v8

```tsx
<Calendar
  selectedDays={date}
  onSelect={setDate}
  fromMonth={new Date(2026, 0)}
  toMonth={new Date(2026, 11)}
/>
```

### v9

```tsx
<Calendar
  mode="single"
  selected={date}
  onSelect={setDate}
  startMonth={new Date(2026, 0)}
  endMonth={new Date(2026, 11)}
/>
```

For `fromDate` / `toDate`, use `hidden` with a matcher :

```tsx
<Calendar
  mode="single"
  selected={date}
  onSelect={setDate}
  startMonth={new Date(2026, 0)}
  endMonth={new Date(2026, 11)}
  hidden={{ before: new Date(2026, 0, 15), after: new Date(2026, 11, 15) }}
/>
```

## 9. TypeScript Type Renames

### v8

```ts
import type {
  DayPickerSingleProps,
  DayPickerMultipleProps,
  DayPickerRangeProps,
} from "react-day-picker"
```

### v9

```ts
import type {
  PropsSingle,
  PropsMulti,
  PropsRange,
  DayPickerProps,
} from "react-day-picker"
```

`DayPickerProps` is retained as the union of all three.
