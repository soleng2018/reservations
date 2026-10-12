import { describe, expect, it } from "vitest";
import { formatDateTime, formatDay, formatTime } from "./format-time";

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
