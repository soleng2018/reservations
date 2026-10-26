import { describe, expect, it } from "vitest";
import {
  freeStarts,
  GAP_MS,
  HORIZON_MS,
  isOfferableStart,
  LEAD_MS,
  SLOT_MS,
  type BusyRange,
} from "./slots";

const HOUR = 3_600_000;
const at = (iso: string) => new Date(iso);
const iso = (ds: readonly Date[]) => ds.map((d) => d.toISOString());

const base = {
  now: at("2026-10-13T08:00:00Z"),
  leadMs: LEAD_MS,
  horizonMs: HORIZON_MS,
  durationMs: 2 * HOUR,
  testbedIds: ["a"],
  busy: [] as readonly BusyRange[],
};

// covers: AC-3, AC-5 (recheck)
describe("freeStarts (AC-3)", () => {
  it("starts exactly one lead time out, on the half hour grid", () => {
    expect(iso(freeStarts(base)).slice(0, 2)).toEqual([
      "2026-10-13T09:00:00.000Z",
      "2026-10-13T09:30:00.000Z",
    ]);
    const late = { ...base, now: at("2026-10-13T08:00:00.001Z") };
    expect(iso(freeStarts(late))[0]).toBe("2026-10-13T09:30:00.000Z");
  });

  it("ends exactly at the horizon", () => {
    const starts = freeStarts(base);
    expect(starts.at(-1)?.getTime()).toBe(base.now.getTime() + HORIZON_MS);
    expect(starts).toHaveLength((HORIZON_MS - LEAD_MS) / SLOT_MS + 1);
  });

  // spec 0010: the window is 90 days.
  it("lists a start exactly 90 days out and none after", () => {
    expect(HORIZON_MS).toBe(90 * 24 * HOUR);
    expect(iso(freeStarts(base)).at(-1)).toBe("2027-01-11T08:00:00.000Z");
  });

  it("holds the cleanup gap on both sides of a busy range (spec 0020 AC-2)", () => {
    const busy = [
      {
        testbedId: "a",
        startsAt: at("2026-10-13T12:00:00Z"),
        endsAt: at("2026-10-13T14:00:00Z"),
      },
    ];
    const starts = iso(freeStarts({ ...base, busy })).slice(0, 12);
    expect(starts).toContain("2026-10-13T09:30:00.000Z"); // ends 11:30, a gap before 12:00
    expect(starts).not.toContain("2026-10-13T10:00:00.000Z"); // ends at 12:00, no gap
    expect(starts).not.toContain("2026-10-13T10:30:00.000Z");
    expect(starts).not.toContain("2026-10-13T13:30:00.000Z");
    expect(starts).not.toContain("2026-10-13T14:00:00.000Z"); // busy ends 14:00, no gap
    expect(starts).toContain("2026-10-13T14:30:00.000Z"); // a gap after 14:00
  });

  it("keeps the lead time at least as long as the gap (spec 0020 AC-10)", () => {
    expect(GAP_MS).toBe(30 * 60 * 1000);
    expect(LEAD_MS).toBeGreaterThanOrEqual(GAP_MS);
  });

  it("blocks a whole day for a day long type", () => {
    const busy = [
      {
        testbedId: "a",
        startsAt: at("2026-10-14T00:00:00Z"),
        endsAt: at("2026-10-15T00:00:00Z"),
      },
    ];
    const starts = iso(freeStarts({ ...base, durationMs: 24 * HOUR, busy }));
    expect(starts).not.toContain("2026-10-13T09:00:00.000Z");
    expect(starts).not.toContain("2026-10-14T12:00:00.000Z");
    expect(starts).not.toContain("2026-10-15T00:00:00.000Z"); // inside the gap
    expect(starts).toContain("2026-10-15T00:30:00.000Z");
  });

  it("offers a start while any testbed of the type is free", () => {
    const busy = [
      {
        testbedId: "a",
        startsAt: at("2026-10-13T09:00:00Z"),
        endsAt: at("2026-10-13T11:00:00Z"),
      },
    ];
    expect(iso(freeStarts({ ...base, busy }))[0]).toBe(
      "2026-10-13T11:30:00.000Z",
    );
    expect(iso(freeStarts({ ...base, testbedIds: ["a", "b"], busy }))[0]).toBe(
      "2026-10-13T09:00:00.000Z",
    );
  });

  it("offers nothing without a testbed", () => {
    expect(freeStarts({ ...base, testbedIds: [] })).toEqual([]);
  });
});

describe("isOfferableStart (AC-7 recheck)", () => {
  const now = at("2026-10-13T08:10:00Z");
  const check = (s: string) =>
    isOfferableStart(at(s), now, LEAD_MS, HORIZON_MS);

  it("accepts a grid start between the lead time and the horizon", () => {
    expect(check("2026-10-13T09:30:00Z")).toBe(true);
    expect(check("2027-01-11T08:00:00Z")).toBe(true); // 90 days out
  });

  it("refuses a start inside the lead time, past the horizon, or off grid", () => {
    expect(check("2026-10-13T09:00:00Z")).toBe(false);
    expect(check("2027-01-11T08:30:00Z")).toBe(false); // 90 days plus 30 min
    expect(check("2026-10-13T10:15:00Z")).toBe(false);
  });
});
