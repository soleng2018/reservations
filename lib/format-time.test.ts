import { describe, expect, it } from "vitest";
import {
  formatDateTime,
  formatDay,
  formatTime,
  groupByDay,
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

describe("groupByDay (AC-3)", () => {
  it("returns no groups for no starts", () => {
    expect(groupByDay([], "UTC")).toEqual([]);
  });

  it("groups starts by their calendar day in the zone, in order", () => {
    const starts = [
      at("2026-10-13T09:00:00Z"),
      at("2026-10-13T09:30:00Z"),
      at("2026-10-14T09:00:00Z"),
    ];
    expect(groupByDay(starts, "UTC")).toEqual([
      { key: "2026-10-13", label: "Tue, Oct 13", starts: starts.slice(0, 2) },
      { key: "2026-10-14", label: "Wed, Oct 14", starts: starts.slice(2) },
    ]);
  });

  it("moves a start across midnight into the zone's next day", () => {
    const starts = [at("2026-10-13T17:00:00Z"), at("2026-10-13T19:00:00Z")];
    expect(groupByDay(starts, "UTC").map((g) => g.key)).toEqual(["2026-10-13"]);
    expect(groupByDay(starts, "Asia/Kolkata").map((g) => g.key)).toEqual([
      "2026-10-13",
      "2026-10-14",
    ]);
  });

  it("does not change the input array", () => {
    const starts = Object.freeze([T, at("2026-10-14T13:00:00Z")]);
    groupByDay(starts, "UTC");
    expect(starts).toHaveLength(2);
  });
});
