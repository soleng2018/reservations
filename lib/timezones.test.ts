import { describe, expect, it } from "vitest";
import { formatDateTime, groupByDay } from "./format-time";
import { isTimeZone, Timezone, timezoneOptions } from "./timezones";

// covers: AC-3, AC-4 (timezone parse), AC-6 (display)
describe("timezones (AC-3, AC-4)", () => {
  it("accepts real zones and aliases, refuses anything else", () => {
    expect(isTimeZone("America/New_York")).toBe(true);
    expect(isTimeZone("Asia/Calcutta")).toBe(true);
    expect(isTimeZone("UTC")).toBe(true);
    expect(isTimeZone("Mars/Olympus")).toBe(false);
    expect(isTimeZone("")).toBe(false);
    expect(Timezone.safeParse(" Europe/Paris ").data).toBe("Europe/Paris");
    expect(Timezone.safeParse("Not/AZone").success).toBe(false);
  });

  it("lists every zone plus UTC and the browser's alias, once each, sorted", () => {
    const list = timezoneOptions("Asia/Calcutta");
    expect(list).toContain("UTC");
    expect(list).toContain("Asia/Calcutta");
    expect(new Set(list).size).toBe(list.length);
    expect([...list].sort()).toEqual(list);
    expect(timezoneOptions("bogus")).not.toContain("bogus");
  });
});

describe("groupByDay (AC-3)", () => {
  const starts = [
    "2026-10-13T03:30:00Z",
    "2026-10-13T04:00:00Z",
    "2026-10-13T05:00:00Z",
  ].map((s) => new Date(s));

  it("groups by the calendar day in the chosen zone", () => {
    expect(groupByDay(starts, "UTC").map((g) => g.starts.length)).toEqual([3]);
    const ny = groupByDay(starts, "America/New_York");
    expect(ny.map((g) => [g.key, g.starts.length])).toEqual([
      ["2026-10-12", 1], // 03:30Z is 11:30 PM EDT
      ["2026-10-13", 2], // 04:00Z is midnight
    ]);
    expect(ny[0]?.label).toBe("Mon, Oct 12");
  });

  it("formats a time with its zone", () => {
    expect(
      formatDateTime(new Date("2026-10-13T13:00:00Z"), "America/New_York"),
    ).toBe("Tue, Oct 13, 2026, 9:00 AM EDT");
  });
});
