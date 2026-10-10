import { describe, expect, it } from "vitest";
import {
  freeStarts,
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

  it("allows back to back bookings, never an overlap", () => {
    const busy = [
      {
        testbedId: "a",
        startsAt: at("2026-10-13T12:00:00Z"),
        endsAt: at("2026-10-13T14:00:00Z"),
      },
    ];
    const starts = iso(freeStarts({ ...base, busy })).slice(0, 12);
    expect(starts).toContain("2026-10-13T10:00:00.000Z"); // ends at 12:00
    expect(starts).not.toContain("2026-10-13T10:30:00.000Z");
    expect(starts).not.toContain("2026-10-13T13:30:00.000Z");
    expect(starts).toContain("2026-10-13T14:00:00.000Z"); // starts at 14:00
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
    expect(starts).toContain("2026-10-15T00:00:00.000Z");
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
      "2026-10-13T11:00:00.000Z",
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
    expect(check("2026-10-27T08:00:00Z")).toBe(true);
  });

  it("refuses a start inside the lead time, past the horizon, or off grid", () => {
    expect(check("2026-10-13T09:00:00Z")).toBe(false);
    expect(check("2026-10-27T08:30:00Z")).toBe(false);
    expect(check("2026-10-13T10:15:00Z")).toBe(false);
  });
});
