import { SLOT_MS } from "./slots";

// Calendar days for the booking time step (spec 0010 AC-4, AC-5). Pure,
// Intl only: the zone is always passed in. A day key is yyyy-mm-dd in the
// chosen zone; a month key is yyyy-mm.

const HOUR_MS = 3_600_000;

export const dayKey = (d: Date, timeZone: string): string =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);

// The days that hold at least one free start, in the zone.
export const freeDayKeys = (
  starts: readonly Date[],
  timeZone: string,
): ReadonlySet<string> => new Set(starts.map((s) => dayKey(s, timeZone)));

// Every half hour start of the local day: the UTC half hour grid from 14
// hours before the key's UTC midnight to 38 hours after, kept where the start
// falls on that day in the zone. DST days and :45 offsets fall out of this
// (46 or 50 starts on a US change day, :15 and :45 in Asia/Kathmandu).
export function halfHoursOfDay(key: string, timeZone: string): readonly Date[] {
  const [y, m, d] = key.split("-").map(Number);
  const midnight = Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1);
  const from = midnight - 14 * HOUR_MS;
  const count = (52 * HOUR_MS) / SLOT_MS;
  return Array.from(
    { length: count },
    (_, i) => new Date(from + i * SLOT_MS),
  ).filter((s) => dayKey(s, timeZone) === key);
}

export type HourRow = {
  readonly key: string;
  readonly label: string; // "9 AM", or "1 AM EDT" on a repeated hour
  readonly starts: readonly Date[];
};

const hourLabel = (d: Date, timeZone: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric" }).format(d);

const zoneAbbr = (d: Date, timeZone: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" })
    .formatToParts(d)
    .find((p) => p.type === "timeZoneName")?.value ?? "";

// Starts grouped into rows by the local hour they start in. The hour that
// repeats when clocks fall back becomes two rows, each labelled with its zone
// abbreviation.
export function hourRows(
  starts: readonly Date[],
  timeZone: string,
): readonly HourRow[] {
  const rows = starts.reduce<
    readonly { hour: string; abbr: string; starts: readonly Date[] }[]
  >((acc, start) => {
    const hour = hourLabel(start, timeZone);
    const abbr = zoneAbbr(start, timeZone);
    const last = acc.at(-1);
    return last?.hour === hour && last.abbr === abbr
      ? [...acc.slice(0, -1), { ...last, starts: [...last.starts, start] }]
      : [...acc, { hour, abbr, starts: [start] }];
  }, []);
  const repeated = (hour: string) =>
    rows.filter((r) => r.hour === hour).length > 1;
  return rows.map((r) => ({
    key: r.starts[0]?.toISOString() ?? r.hour,
    label: repeated(r.hour) ? `${r.hour} ${r.abbr}` : r.hour,
    starts: r.starts,
  }));
}

// The months the guest may page through: from now's month to the month of
// now plus the horizon, in the zone.
export const monthRange = (
  now: Date,
  horizonMs: number,
  timeZone: string,
): { readonly first: string; readonly last: string } => ({
  first: dayKey(now, timeZone).slice(0, 7),
  last: dayKey(new Date(now.getTime() + horizonMs), timeZone).slice(0, 7),
});

// The calendar works on "floating" dates: browser local noon of the key
// (never midnight, which some zones skip at DST). A month key gives its 1st.
export function keyToLocalDate(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y ?? 0, (m ?? 1) - 1, d ?? 1, 12);
}

// "Tuesday, October 13": the key's own day, whatever the machine's zone.
export function dayLabel(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1, 12));
}

export const localDateToKey = (d: Date): string =>
  [
    String(d.getFullYear()).padStart(4, "0"),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
  ].join("-");
