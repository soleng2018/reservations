// Times shown to the learner in their chosen zone (spec 0004 AC-3, AC-6).
// Pure: the zone is always passed in, never read from the machine.

export type DayGroup = {
  readonly key: string; // yyyy-mm-dd in the zone
  readonly label: string; // "Tue, Oct 13"
  readonly starts: readonly Date[];
};

const dayKey = (d: Date, timeZone: string) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);

export const formatDay = (d: Date, timeZone: string) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(d);

export const formatTime = (d: Date, timeZone: string) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(d);

// "Tue, Oct 13, 2026, 9:00 AM EDT"
export const formatDateTime = (d: Date, timeZone: string) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(d);

// Starts grouped by their calendar day in the zone, in order.
export function groupByDay(
  starts: readonly Date[],
  timeZone: string,
): readonly DayGroup[] {
  return starts.reduce<readonly DayGroup[]>((groups, start) => {
    const key = dayKey(start, timeZone);
    const last = groups.at(-1);
    return last?.key === key
      ? [...groups.slice(0, -1), { ...last, starts: [...last.starts, start] }]
      : [
          ...groups,
          { key, label: formatDay(start, timeZone), starts: [start] },
        ];
  }, []);
}
