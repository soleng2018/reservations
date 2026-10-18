// Times shown to the learner in their chosen zone (spec 0004 AC-3, AC-6).
// Pure: the zone is always passed in, never read from the machine.

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

// Intl names these "GMT+0" under shortGeneric; the booking screens say "UTC"
// (spec 0013 AC-14, amended 2026-10-17). Matched on the id as stored.
const UTC_ZONES: ReadonlySet<string> = new Set(["UTC", "Etc/UTC", "Etc/GMT"]);

// V8's format() turns ICU's narrow no break space before AM/PM into a plain
// space; formatToParts() does not, so match format() here.
const NARROW_NBSP = / /g;

// Spec 0013 AC-14: every time in an email. A generic zone name, so it reads
// the same all year: "Tue, Oct 13, 2026, 9:00 AM ET", "… Germany Time".
export const formatEmailDateTime = (d: Date, timeZone: string) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "shortGeneric",
  })
    .formatToParts(d)
    .map((p) =>
      p.type === "timeZoneName" && UTC_ZONES.has(timeZone)
        ? "UTC"
        : p.value.replace(NARROW_NBSP, " "),
    )
    .join("");
