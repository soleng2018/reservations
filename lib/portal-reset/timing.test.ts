import { describe, expect, it } from "vitest";
import { ACCESS_LEAD_MS } from "@/lib/lab-access";
import * as t from "./timing";

describe("timing", () => {
  it("holds the spec 0023 values", () => {
    expect(t.START_DELAY).toBe(300_000);
    expect(t.TARGET).toBe(1_440_000);
    expect(t.HARD_CAP).toBe(7_200_000);
    expect(t.LEASE).toBe(90_000);
    expect(t.START_DELAY).toBeLessThan(t.TARGET);
    expect(t.TARGET).toBeLessThan(t.HARD_CAP);
  });

  // Spec 0029: lab access opens 5 minutes early, and the reset stops a minute
  // before that, so a reset (due 5 minutes after the end of a lab) has 19
  // minutes inside the 30 minute gap.
  it("opens access 5 minutes early and stops the reset a minute before that", () => {
    expect(ACCESS_LEAD_MS).toBe(300_000);
    expect(t.RESET_SAFETY_MS).toBe(60_000);
    expect(t.START_MARGIN).toBe(ACCESS_LEAD_MS + t.RESET_SAFETY_MS);
    const GAP = 30 * 60_000;
    expect(t.TARGET).toBe(GAP - t.START_MARGIN);
    // The window the reset has: due 5 minutes after the end, 19 minutes long.
    expect(t.TARGET - t.START_DELAY).toBe(19 * 60_000);
  });
});
