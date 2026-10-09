import { z } from "zod";

// IANA timezones for the booking form (spec 0004 AC-3, AC-4). The list is
// only for display; the check is whether Intl accepts the zone, so ICU
// differences between the browser and Node never reject a real zone.

export function isTimeZone(zone: string): boolean {
  if (zone === "") return false;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export const Timezone = z
  .string()
  .trim()
  .max(100, "Choose a timezone from the list.")
  .refine(isTimeZone, "Choose a timezone from the list.");

// Every supported zone plus UTC plus the browser's own zone (it may be an
// alias such as Asia/Calcutta that the list lacks), sorted, no duplicates.
export function timezoneOptions(browserZone: string): readonly string[] {
  const extra = isTimeZone(browserZone) ? [browserZone] : [];
  return [
    ...new Set([...Intl.supportedValuesOf("timeZone"), "UTC", ...extra]),
  ].sort();
}

// The browser's zone, or UTC when it is missing or not accepted.
export function browserTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone && isTimeZone(zone) ? zone : "UTC";
  } catch {
    return "UTC";
  }
}
