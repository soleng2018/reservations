import { describe, expect, it } from "vitest";
import {
  formatDateTime,
  formatDay,
  formatEmailDateTime,
  formatTime,
} from "./format-time";

// Tuesday 2026-10-13, 13:00 UTC.
const at = (iso: string) => new Date(iso);
const T = at("2026-10-13T13:00:00Z");

// covers: AC-3 (starts shown in the chosen zone), AC-6 (confirmation times)
describe("formatTime (AC-3)", () => {
  it("shows the same instant in the chosen zone, not the machine's", () => {
    expect(formatTime(T, "UTC")).toBe("1:00 PM");
    expect(formatTime(T, "America/New_York")).toBe("9:00 AM");
  });

  it("shows half hour zones on the half hour", () => {
    expect(formatTime(T, "Asia/Kolkata")).toBe("6:30 PM");
    expect(formatTime(T, "Asia/Calcutta")).toBe("6:30 PM");
    expect(formatTime(T, "America/St_Johns")).toBe("10:30 AM");
  });
});

describe("formatDay", () => {
  it("names the day in the zone, which can differ from UTC", () => {
    const late = at("2026-10-13T23:30:00Z");
    expect(formatDay(late, "UTC")).toBe("Tue, Oct 13");
    expect(formatDay(late, "Asia/Kolkata")).toBe("Wed, Oct 14");
  });
});

describe("formatDateTime (AC-6)", () => {
  it("includes the year and a short zone name", () => {
    expect(formatDateTime(T, "America/New_York")).toBe(
      "Tue, Oct 13, 2026, 9:00 AM EDT",
    );
  });
});

// covers: spec 0013 AC-14
describe("formatEmailDateTime (spec 0013 AC-14)", () => {
  const start = new Date("2026-10-13T13:00:00Z");
  it("matches the template for New York", () => {
    expect(formatEmailDateTime(start, "America/New_York")).toBe(
      "Tue, Oct 13, 2026, 9:00 AM ET",
    );
  });
  it("uses a generic zone name elsewhere", () => {
    expect(formatEmailDateTime(start, "Asia/Kolkata")).toBe(
      "Tue, Oct 13, 2026, 6:30 PM India Time",
    );
    expect(formatEmailDateTime(start, "Europe/Berlin")).toBe(
      "Tue, Oct 13, 2026, 3:00 PM Germany Time",
    );
  });
  // Amended 2026-10-17: Intl says "GMT+0" for these; the screens say "UTC".
  it("names the UTC zones UTC, and leaves other GMT zones alone", () => {
    const late = new Date("2026-10-17T01:30:00Z");
    for (const zone of ["UTC", "Etc/UTC", "Etc/GMT"]) {
      expect(formatEmailDateTime(late, zone)).toBe(
        "Sat, Oct 17, 2026, 1:30 AM UTC",
      );
    }
    expect(formatEmailDateTime(late, "Africa/Abidjan")).toBe(
      "Sat, Oct 17, 2026, 1:30 AM GMT",
    );
  });

  // The formatToParts rewrite must print exactly what format() printed for
  // every zone it doesn't rename, in summer and in winter.
  it("prints what Intl's format() prints for every zone it does not rename", () => {
    const renamed = new Set(["UTC", "Etc/UTC", "Etc/GMT"]);
    const options: Intl.DateTimeFormatOptions = {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "shortGeneric",
    };
    const zones = Intl.supportedValuesOf("timeZone").filter(
      (z) => !renamed.has(z),
    );
    for (const d of [start, new Date("2027-01-15T22:45:00Z")]) {
      const mismatches = zones.filter(
        (timeZone) =>
          formatEmailDateTime(d, timeZone) !==
          new Intl.DateTimeFormat("en-US", { ...options, timeZone }).format(d),
      );
      expect(mismatches).toEqual([]);
    }
  });

  it("puts a plain space before AM and PM, never a narrow no break space", () => {
    for (const zone of ["UTC", "America/New_York", "Asia/Kolkata"]) {
      for (const d of [start, new Date("2026-10-17T01:30:00Z")]) {
        expect(formatEmailDateTime(d, zone)).not.toContain(" ");
        expect(formatEmailDateTime(d, zone)).toMatch(/\d [AP]M /);
      }
    }
  });
});
