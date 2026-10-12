import { describe, expect, it } from "vitest";
import {
  dayKey,
  freeDayKeys,
  halfHoursOfDay,
  hourRows,
  keyToLocalDate,
  localDateToKey,
  monthRange,
} from "./calendar-days";
import { formatTime } from "./format-time";

const DAY = 24 * 3_600_000;
const at = (iso: string) => new Date(iso);
const times = (starts: readonly Date[], tz: string) =>
  starts.map((s) => formatTime(s, tz));

// covers: spec 0010 AC-4, AC-5
describe("dayKey (AC-4)", () => {
  it("names the calendar day in the zone, which can differ from UTC", () => {
    expect(dayKey(at("2026-10-13T23:30:00Z"), "UTC")).toBe("2026-10-13");
    expect(dayKey(at("2026-10-13T23:30:00Z"), "Asia/Tokyo")).toBe("2026-10-14");
  });
});

describe("freeDayKeys (AC-4)", () => {
  it("puts a start at 23:30 UTC on the next day in Tokyo", () => {
    const starts = [at("2026-10-13T09:00:00Z"), at("2026-10-13T23:30:00Z")];
    expect([...freeDayKeys(starts, "UTC")]).toEqual(["2026-10-13"]);
    expect([...freeDayKeys(starts, "Asia/Tokyo")]).toEqual([
      "2026-10-13",
      "2026-10-14",
    ]);
  });

  it("is empty with no starts", () => {
    expect(freeDayKeys([], "UTC").size).toBe(0);
  });
});

describe("halfHoursOfDay (AC-5)", () => {
  it("gives 48 starts on a normal day, from local midnight", () => {
    const day = halfHoursOfDay("2026-10-13", "America/New_York");
    expect(day).toHaveLength(48);
    expect(times(day, "America/New_York").slice(0, 2)).toEqual([
      "12:00 AM",
      "12:30 AM",
    ]);
    expect(times(day, "America/New_York").at(-1)).toBe("11:30 PM");
  });

  it("gives 46 when clocks spring forward and 50 when they fall back", () => {
    expect(halfHoursOfDay("2026-03-08", "America/New_York")).toHaveLength(46);
    expect(halfHoursOfDay("2026-11-01", "America/New_York")).toHaveLength(50);
  });

  it("starts at :15 and :45 in a :45 offset zone", () => {
    const day = halfHoursOfDay("2026-10-13", "Asia/Kathmandu");
    expect(day).toHaveLength(48);
    expect(times(day, "Asia/Kathmandu").slice(0, 2)).toEqual([
      "12:15 AM",
      "12:45 AM",
    ]);
  });

  it("starts at :00 and :30 in a :30 offset zone", () => {
    const day = halfHoursOfDay("2026-10-13", "Asia/Kolkata");
    expect(day).toHaveLength(48);
    expect(times(day, "Asia/Kolkata").slice(0, 2)).toEqual([
      "12:00 AM",
      "12:30 AM",
    ]);
  });

  // Lord Howe shifts by 30 minutes, so a change day loses or gains one start.
  it("handles a half hour DST change", () => {
    expect(halfHoursOfDay("2026-10-13", "Australia/Lord_Howe")).toHaveLength(
      48,
    );
    expect(halfHoursOfDay("2026-10-04", "Australia/Lord_Howe")).toHaveLength(
      47,
    );
    expect(halfHoursOfDay("2026-04-05", "Australia/Lord_Howe")).toHaveLength(
      49,
    );
  });

  it("keeps every start on the key's day", () => {
    const tz = "Pacific/Kiritimati"; // UTC+14
    const day = halfHoursOfDay("2026-10-13", tz);
    expect(day).toHaveLength(48);
    expect(new Set(day.map((s) => dayKey(s, tz)))).toEqual(
      new Set(["2026-10-13"]),
    );
  });
});

describe("hourRows (AC-5)", () => {
  it("rows two starts per local hour", () => {
    const rows = hourRows(halfHoursOfDay("2026-10-13", "UTC"), "UTC");
    expect(rows).toHaveLength(24);
    expect(rows[9]?.label).toBe("9 AM");
    expect(times(rows[9]?.starts ?? [], "UTC")).toEqual(["9:00 AM", "9:30 AM"]);
  });

  it("rows 9:15 and 9:45 under 9 AM in Kathmandu", () => {
    const tz = "Asia/Kathmandu";
    const row = hourRows(halfHoursOfDay("2026-10-13", tz), tz).find(
      (r) => r.label === "9 AM",
    );
    expect(times(row?.starts ?? [], tz)).toEqual(["9:15 AM", "9:45 AM"]);
  });

  it("splits the repeated fall back hour by zone abbreviation", () => {
    const tz = "America/New_York";
    const rows = hourRows(halfHoursOfDay("2026-11-01", tz), tz);
    expect(rows).toHaveLength(25);
    expect(rows.map((r) => r.label).slice(0, 4)).toEqual([
      "12 AM",
      "1 AM EDT",
      "1 AM EST",
      "2 AM",
    ]);
  });

  it("skips the missing spring forward hour", () => {
    const tz = "America/New_York";
    const labels = hourRows(halfHoursOfDay("2026-03-08", tz), tz).map(
      (r) => r.label,
    );
    expect(labels).toHaveLength(23);
    expect(labels).not.toContain("2 AM");
  });

  it("has unique keys", () => {
    const tz = "America/New_York";
    const rows = hourRows(halfHoursOfDay("2026-11-01", tz), tz);
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
  });
});

describe("monthRange (AC-4)", () => {
  it("spans four months with 90 days from late in a month", () => {
    expect(monthRange(at("2026-10-25T15:00:00Z"), 90 * DAY, "UTC")).toEqual({
      first: "2026-10",
      last: "2027-01",
    });
  });

  it("spans three months with 90 days from the 1st", () => {
    expect(monthRange(at("2026-10-01T15:00:00Z"), 90 * DAY, "UTC")).toEqual({
      first: "2026-10",
      last: "2026-12",
    });
  });

  it("reads the months in the zone", () => {
    const lateUtc = at("2026-09-30T23:00:00Z");
    expect(monthRange(lateUtc, 0, "UTC").first).toBe("2026-09");
    expect(monthRange(lateUtc, 0, "Asia/Tokyo").first).toBe("2026-10");
  });
});

describe("floating dates (AC-4)", () => {
  it("gives browser local noon of the key", () => {
    const d = keyToLocalDate("2026-03-08");
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()]).toEqual([
      2026, 2, 8, 12,
    ]);
  });

  it("gives the 1st for a month key", () => {
    expect(localDateToKey(keyToLocalDate("2026-11"))).toBe("2026-11-01");
  });

  it("round trips a key", () => {
    expect(localDateToKey(keyToLocalDate("2027-01-31"))).toBe("2027-01-31");
  });
});
