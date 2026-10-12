# shadcn ui : Calendar + DatePicker : Examples

Production-shape examples for every documented mode and recipe. All code is verbatim or minimally adapted from the shadcn-ui/ui new-york-v4 registry examples (verified 2026-05-19). All files mounting a Calendar are top-prefixed with `"use client"` ; this is non-negotiable.

---

## Example 1 : Single-date Calendar (standalone, always-visible)

```tsx
"use client"

import * as React from "react"
import { Calendar } from "@/components/ui/calendar"

export default function SingleDateCalendar() {
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

When to reach for it : the calendar is the primary surface (booking page, planner header, admin date filter). Clicking the currently-selected day a second time calls `setDate(undefined)`.

---

## Example 2 : Multiple-date Calendar (any-day-checklist)

```tsx
"use client"

import * as React from "react"
import { Calendar } from "@/components/ui/calendar"

export default function MultiDateCalendar() {
  const [days, setDays] = React.useState<Date[] | undefined>([])

  return (
    <Calendar
      mode="multiple"
      selected={days}
      onSelect={setDays}
      min={1}
      max={5}
      className="rounded-md border shadow-sm"
    />
  )
}
```

`min` and `max` cap the array size. ALWAYS type the state as `Date[] | undefined` (NEVER `Date[]` alone, since the user can deselect down to empty).

---

## Example 3 : Range Calendar (two-month side-by-side)

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
      className="rounded-md border shadow-sm"
    />
  )
}
```

`numberOfMonths={2}` is the documented canonical range UX. `defaultMonth={range?.from}` keeps the visible month aligned with the selection when re-opening.

---

## Example 4 : DatePicker recipe (single)

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

`PopoverContent` MUST carry `className="w-auto p-0"` ; the default `p-4` would clip the day grid. `align="start"` anchors the popover under the left edge of the trigger.

---

## Example 5 : DatePicker recipe (range, two-month popover)

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

export function DatePickerRange({
  className,
}: React.HTMLAttributes<HTMLDivElement>) {
  const [date, setDate] = React.useState<DateRange | undefined>({
    from: new Date(),
    to: addDays(new Date(), 7),
  })

  return (
    <div className={cn("grid gap-2", className)}>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            id="date"
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
    </div>
  )
}
```

The label branches three ways : (1) full range when both `from` and `to` exist, (2) start-only while mid-drag, (3) placeholder when nothing is selected. NEVER collapse these into a single conditional.

---

## Example 6 : Locale (Dutch via date-fns/locale)

```tsx
"use client"

import * as React from "react"
import { format } from "date-fns"
import { nl } from "date-fns/locale"
import { CalendarIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

export function DatePickerNL() {
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
          {date
            ? format(date, "PPP", { locale: nl })
            : <span>Kies een datum</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={date}
          onSelect={setDate}
          locale={nl}
        />
      </PopoverContent>
    </Popover>
  )
}
```

Two `locale` consumers exist : (1) the Calendar (weekday + month labels), (2) the trigger Button's `format()` (date label). BOTH must receive `nl` ; the Calendar's locale does not propagate into the Button.

---

## Example 7 : Disabled dates (past dates, weekends, fixed list)

```tsx
"use client"

import * as React from "react"
import { isBefore, isWeekend, startOfToday, addDays } from "date-fns"
import { Calendar } from "@/components/ui/calendar"

export function DatePickerNoPast() {
  const [date, setDate] = React.useState<Date | undefined>()

  return (
    <Calendar
      mode="single"
      selected={date}
      onSelect={setDate}
      disabled={(d) => isBefore(d, startOfToday())}
      className="rounded-md border shadow-sm"
    />
  )
}

export function DatePickerWeekdaysOnly() {
  const [date, setDate] = React.useState<Date | undefined>()

  return (
    <Calendar
      mode="single"
      selected={date}
      onSelect={setDate}
      disabled={isWeekend}
      className="rounded-md border shadow-sm"
    />
  )
}

export function DatePickerWithHolidays() {
  const [date, setDate] = React.useState<Date | undefined>()
  const holidays = [
    new Date(2026, 11, 25), // Christmas Day
    new Date(2026, 11, 26), // Boxing Day
    new Date(2027, 0, 1),   // New Year
  ]

  return (
    <Calendar
      mode="single"
      selected={date}
      onSelect={setDate}
      disabled={[
        { before: startOfToday() },
        { after: addDays(startOfToday(), 90) },
        ...holidays,
      ]}
      className="rounded-md border shadow-sm"
    />
  )
}
```

ALWAYS use date-fns helpers (`isBefore`, `startOfToday`, `isWeekend`, `addDays`) for date math. NEVER hand-roll `new Date().setHours(0,0,0,0)` ; the result is mutable, not type-stable, and breaks DST.

---

## Example 8 : Modifiers + semantic styling (holidays, booked, available)

```tsx
"use client"

import * as React from "react"
import { Calendar } from "@/components/ui/calendar"

export function BookingCalendar() {
  const [date, setDate] = React.useState<Date | undefined>()

  const holidays = [new Date(2026, 11, 25), new Date(2026, 11, 26)]
  const booked = [
    new Date(2026, 5, 10),
    new Date(2026, 5, 11),
    new Date(2026, 5, 12),
  ]

  return (
    <Calendar
      mode="single"
      selected={date}
      onSelect={setDate}
      modifiers={{ holiday: holidays, booked }}
      modifiersClassNames={{
        holiday: "bg-red-100 text-red-900 font-semibold",
        booked: "line-through opacity-50 pointer-events-none",
      }}
      className="rounded-md border shadow-sm"
    />
  )
}
```

`modifiersClassNames.booked` includes `pointer-events-none` to also disable the click ; combine with `disabled={booked}` if the form must reject those days at submit time.

---

## Example 9 : Year + month dropdown captions (date of birth)

```tsx
"use client"

import * as React from "react"
import { Calendar } from "@/components/ui/calendar"

export function DateOfBirthCalendar() {
  const [date, setDate] = React.useState<Date | undefined>()

  return (
    <Calendar
      mode="single"
      selected={date}
      onSelect={setDate}
      captionLayout="dropdown"
      startMonth={new Date(1900, 0)}
      endMonth={new Date()}
      className="rounded-md border shadow-sm"
    />
  )
}
```

`captionLayout="dropdown"` swaps the prev/next chevrons for two `<select>` dropdowns (month + year). ALWAYS bound the year range with `startMonth` + `endMonth` ; without them the year dropdown shows the entire `Date` range and is unusable.

---

## Example 10 : DatePicker with presets (Today / Tomorrow / In a week)

```tsx
"use client"

import * as React from "react"
import { addDays, format } from "date-fns"
import { CalendarIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

export function DatePickerWithPresets() {
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
      <PopoverContent
        align="start"
        className="flex w-auto flex-col space-y-2 p-2"
      >
        <Select
          onValueChange={(value) =>
            setDate(addDays(new Date(), parseInt(value)))
          }
        >
          <SelectTrigger>
            <SelectValue placeholder="Select" />
          </SelectTrigger>
          <SelectContent position="popper">
            <SelectItem value="0">Today</SelectItem>
            <SelectItem value="1">Tomorrow</SelectItem>
            <SelectItem value="3">In 3 days</SelectItem>
            <SelectItem value="7">In a week</SelectItem>
          </SelectContent>
        </Select>
        <div className="rounded-md border">
          <Calendar mode="single" selected={date} onSelect={setDate} />
        </div>
      </PopoverContent>
    </Popover>
  )
}
```

Presets and the Calendar share the same `setDate` ; either path updates the same state. The Select's `position="popper"` is required when it is nested inside another popover, otherwise its menu mis-aligns.

---

## Example 11 : Form integration (react-hook-form Controller)

```tsx
"use client"

import * as React from "react"
import { format } from "date-fns"
import { CalendarIcon } from "lucide-react"
import { useForm, Controller } from "react-hook-form"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

type FormValues = { dueDate: Date | undefined }

export function DueDateForm() {
  const { control, handleSubmit } = useForm<FormValues>({
    defaultValues: { dueDate: undefined },
  })

  return (
    <form onSubmit={handleSubmit((v) => console.log(v))}>
      <Controller
        control={control}
        name="dueDate"
        render={({ field }) => (
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                className={cn(
                  "w-[240px] justify-start text-left font-normal",
                  !field.value && "text-muted-foreground"
                )}
              >
                <CalendarIcon />
                {field.value
                  ? format(field.value, "PPP")
                  : <span>Pick a due date</span>}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <Calendar
                mode="single"
                selected={field.value}
                onSelect={field.onChange}
              />
            </PopoverContent>
          </Popover>
        )}
      />
      <Button type="submit">Save</Button>
    </form>
  )
}
```

ALWAYS use `Controller` (NEVER `register`) for Calendar fields in react-hook-form ; `register` cannot wire `onSelect` and the form state will never update. See `shadcn-syntax-form` for the full Controller + FormField pattern with FormItem / FormLabel / FormDescription / FormMessage.

---

## Sources

- `apps/v4/registry/new-york-v4/examples/calendar-demo.tsx`
- `apps/v4/registry/new-york-v4/examples/date-picker-demo.tsx`
- `apps/v4/registry/new-york-v4/examples/date-picker-with-range.tsx`
- `apps/v4/registry/new-york-v4/examples/date-picker-with-presets.tsx`
- `apps/v4/registry/new-york-v4/ui/calendar.tsx`
- https://ui.shadcn.com/docs/components/radix/calendar
- https://ui.shadcn.com/docs/components/radix/date-picker
