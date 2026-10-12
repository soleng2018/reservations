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

// ICU lists these zones under their old CLDR names (Node and Chromium alike),
// so a guest searching "kolkata" or "kyiv" would find nothing (spec 0010
// AC-1). Both names are the same zone to Intl.
const CURRENT_NAME: Readonly<Record<string, string>> = {
  "Africa/Asmera": "Africa/Asmara",
  "America/Buenos_Aires": "America/Argentina/Buenos_Aires",
  "America/Catamarca": "America/Argentina/Catamarca",
  "America/Coral_Harbour": "America/Atikokan",
  "America/Cordoba": "America/Argentina/Cordoba",
  "America/Godthab": "America/Nuuk",
  "America/Indianapolis": "America/Indiana/Indianapolis",
  "America/Jujuy": "America/Argentina/Jujuy",
  "America/Louisville": "America/Kentucky/Louisville",
  "America/Mendoza": "America/Argentina/Mendoza",
  "Asia/Calcutta": "Asia/Kolkata",
  "Asia/Katmandu": "Asia/Kathmandu",
  "Asia/Rangoon": "Asia/Yangon",
  "Asia/Saigon": "Asia/Ho_Chi_Minh",
  "Atlantic/Faeroe": "Atlantic/Faroe",
  "Europe/Kiev": "Europe/Kyiv",
  "Pacific/Enderbury": "Pacific/Kanton",
  "Pacific/Ponape": "Pacific/Pohnpei",
  "Pacific/Truk": "Pacific/Chuuk",
};

// The zone's current IANA name, when Intl accepts it.
export function currentZoneName(zone: string): string {
  const current = CURRENT_NAME[zone];
  return current !== undefined && isTimeZone(current) ? current : zone;
}

// Every supported zone under its current name, plus UTC plus the browser's
// own zone (it may be an alias the list lacks), sorted, no duplicates.
export function timezoneOptions(browserZone: string): readonly string[] {
  const extra = isTimeZone(browserZone) ? [currentZoneName(browserZone)] : [];
  return [
    ...new Set([
      ...Intl.supportedValuesOf("timeZone").map(currentZoneName),
      "UTC",
      ...extra,
    ]),
  ].sort();
}

// "America/New York (GMT-4)", "UTC (GMT)": the zone with its offset at `at`
// (spec 0010 AC-1, AC-7). Display only.
export function zoneLabel(zone: string, at: Date): string {
  const offset =
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      timeZoneName: "shortOffset",
    })
      .formatToParts(at)
      .find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const gmt = offset === "GMT+0" || offset === "GMT-0" ? "GMT" : offset;
  return `${zone.replaceAll("_", " ")} (${gmt})`;
}

// The browser's zone under its current name, or UTC when it is missing or
// not accepted.
export function browserTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone && isTimeZone(zone) ? currentZoneName(zone) : "UTC";
  } catch {
    return "UTC";
  }
}
