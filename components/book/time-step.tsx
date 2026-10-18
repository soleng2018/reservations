"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarIcon } from "lucide-react";
import { Calendar } from "@/components/ui/calendar";
import {
  dayKey,
  dayLabel,
  freeDayKeys,
  halfHoursOfDay,
  hourRows,
  keyToLocalDate,
  localDateToKey,
  monthRange,
} from "@/lib/calendar-days";
import { formatDateTime, formatTime } from "@/lib/format-time";
import { HORIZON_MS } from "@/lib/slots";
import { cn } from "@/lib/utils";

// The time picker of Step 2 (spec 0010 AC-4, AC-5, AC-6). Plain props, so
// feature 13's reschedule reuses it: the server's free starts (ISO), the
// type's length, the DB clock, and the chosen zone. It never reads the
// browser clock. A reschedule passes the booking's `currentStart`, shown as
// "Current" and never pickable, and the calendar opens on its month when
// that month is in range (spec 0011 AC-7).
export function TimeStep({
  starts,
  durationMs,
  durationLabel,
  now,
  timezone,
  day,
  picked,
  currentStart,
  onPickDay,
  onPick,
}: {
  readonly starts: readonly string[];
  readonly durationMs: number;
  readonly durationLabel: string;
  readonly now: string;
  readonly timezone: string;
  readonly day: string | null;
  readonly picked: string | null;
  readonly currentStart?: string;
  readonly onPickDay: (key: string) => void;
  readonly onPick: (iso: string) => void;
}) {
  const nowDate = useMemo(() => new Date(now), [now]);
  const free = useMemo(() => new Set(starts), [starts]);
  const freeDays = useMemo(
    () =>
      freeDayKeys(
        starts.map((s) => new Date(s)),
        timezone,
      ),
    [starts, timezone],
  );
  const months = monthRange(nowDate, HORIZON_MS, timezone);
  const firstFree = starts[0];
  const currentMonth = currentStart
    ? dayKey(new Date(currentStart), timezone).slice(0, 7)
    : null;
  const currentInRange =
    currentMonth !== null &&
    currentMonth >= months.first &&
    currentMonth <= months.last;

  // Opens on the picked day's month, else the current booking's (when in
  // range), else the first free start's, else now's.
  const [month, setMonth] = useState(() =>
    keyToLocalDate(
      (
        day ??
        (currentInRange ? currentMonth : null) ??
        (firstFree ? dayKey(new Date(firstFree), timezone) : null) ??
        dayKey(nowDate, timezone)
      ).slice(0, 7),
    ),
  );

  // AC-5: picking a day moves focus to the panel's day heading.
  const heading = useRef<HTMLHeadingElement>(null);
  const shownDay = useRef(day);
  useEffect(() => {
    if (day !== null && day !== shownDay.current) heading.current?.focus();
    shownDay.current = day;
  }, [day]);

  const slots = useMemo(
    () => (day ? halfHoursOfDay(day, timezone) : []),
    [day, timezone],
  );
  const rows = useMemo(() => hourRows(slots, timezone), [slots, timezone]);
  const pickedAt = picked ? new Date(picked).getTime() : null;
  const inReservation = (s: Date) =>
    pickedAt !== null &&
    s.getTime() >= pickedAt &&
    s.getTime() < pickedAt + durationMs;
  const dayHasFree = slots.some((s) => free.has(s.toISOString()));

  return (
    <>
      <div className="flex flex-col overflow-hidden rounded-xl border bg-card shadow-xs md:flex-row">
        <div className="shrink-0 border-b p-4 md:w-95 md:border-r md:border-b-0">
          <Calendar
            mode="single"
            required
            className="w-full"
            classNames={{ root: "w-full" }}
            selected={day ? keyToLocalDate(day) : undefined}
            onSelect={(d: Date) => onPickDay(localDateToKey(d))}
            disabled={(d: Date) => !freeDays.has(localDateToKey(d))}
            month={month}
            onMonthChange={setMonth}
            startMonth={keyToLocalDate(months.first)}
            endMonth={keyToLocalDate(months.last)}
            today={keyToLocalDate(dayKey(nowDate, timezone))}
            weekStartsOn={0}
            formatters={{
              formatWeekdayName: (d: Date) =>
                d.toLocaleDateString("en-US", { weekday: "short" }),
            }}
          />
        </div>

        <div
          className={cn(
            "min-w-0 flex-1 flex-col p-4",
            day ? "flex" : "hidden md:flex",
          )}
        >
          {day ? (
            <>
              <h2
                ref={heading}
                tabIndex={-1}
                className="mb-0.5 text-sub font-semibold text-fg1"
              >
                {dayLabel(day)}
              </h2>
              <p className="mb-2 text-xs text-fg3">
                Pick a start time. Your full {durationLabel} reservation will be
                highlighted below.
              </p>
              <fieldset className="max-h-75 overflow-y-auto rounded-md border">
                <legend className="sr-only">
                  Start times for {dayLabel(day)}
                </legend>
                {rows.map((row) => (
                  <div
                    key={row.key}
                    className="flex items-center gap-2.5 border-t px-2.5 py-0.75 first-of-type:border-t-0"
                  >
                    <span
                      aria-hidden="true"
                      className="w-14 shrink-0 text-[0.6875rem] font-bold text-fg3"
                    >
                      {row.label}
                    </span>
                    <div className="flex flex-1 gap-1.25">
                      {row.starts.map((s) => {
                        const iso = s.toISOString();
                        const isCurrent = iso === currentStart;
                        const open = free.has(iso) && !isCurrent;
                        return (
                          <label
                            key={iso}
                            className={cn(
                              "flex-1",
                              open ? "cursor-pointer" : "cursor-default",
                            )}
                          >
                            <input
                              type="radio"
                              name="startsAt"
                              value={iso}
                              disabled={!open}
                              checked={picked === iso}
                              onChange={() => onPick(iso)}
                              className="peer sr-only"
                            />
                            <span
                              className={cn(
                                "flex min-h-8 flex-col items-center justify-center rounded-[0.375rem] px-1 py-1.5 text-[0.71875rem] leading-tight font-semibold transition-colors duration-120 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring",
                                inReservation(s)
                                  ? "bg-primary text-primary-foreground"
                                  : isCurrent
                                    ? "bg-nile-blue-050 text-nile-blue"
                                    : open
                                      ? "bg-card text-fg1 ring-1 ring-border hover:bg-nile-blue-050"
                                      : "bg-bg-inset text-fg3",
                              )}
                            >
                              {formatTime(s, timezone)}
                              {isCurrent ? (
                                <span className="text-[0.625rem] font-bold tracking-[0.04em] uppercase">
                                  Current
                                </span>
                              ) : null}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </fieldset>
              {dayHasFree ? null : (
                <p className="mt-2 text-[0.8125rem] text-fg3" role="status">
                  No open times left on this day. Try another date.
                </p>
              )}
            </>
          ) : (
            <div className="flex min-h-50 flex-1 flex-col items-center justify-center gap-2 text-center text-fg3">
              <CalendarIcon
                aria-hidden="true"
                className="size-6 text-border-strong"
              />
              <p className="max-w-55 text-[0.8125rem]">
                Select a date to see available start times.
              </p>
            </div>
          )}
        </div>
      </div>

      {pickedAt !== null ? (
        <p
          className="mt-3 rounded-md bg-nile-blue-050 px-4 py-2.75 text-[0.8125rem] font-semibold text-nile-blue"
          aria-live="polite"
        >
          {durationLabel} reservation:{" "}
          {formatDateTime(new Date(pickedAt), timezone)} to{" "}
          {formatDateTime(new Date(pickedAt + durationMs), timezone)}
        </p>
      ) : null}
    </>
  );
}
