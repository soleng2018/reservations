import { describe, expect, it } from "vitest";
import { zoneLabel } from "@/lib/timezones";
import { matchesZone } from "./timezone-combobox";

const summer = new Date("2026-07-01T12:00:00Z");

// covers: spec 0010 AC-1
describe("matchesZone (AC-1)", () => {
  const ny = zoneLabel("America/New_York", summer);
  const kolkata = zoneLabel("Asia/Kolkata", summer);

  it("matches a case insensitive substring of the visible label", () => {
    expect(matchesZone(ny, "york")).toBe(true);
    expect(matchesZone(ny, "gmt-4")).toBe(true);
    expect(matchesZone(ny, "New York")).toBe(true);
    expect(matchesZone(kolkata, "kolkata")).toBe(true);
  });

  it("does not match the underscored id or another zone", () => {
    expect(matchesZone(ny, "new_york")).toBe(false);
    expect(matchesZone(ny, "kolkata")).toBe(false);
  });

  it("matches everything for an empty query", () => {
    expect(matchesZone(ny, "  ")).toBe(true);
  });
});
