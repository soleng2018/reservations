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
  }).format(d);
