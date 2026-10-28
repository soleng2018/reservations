import { describe, expect, it } from "vitest";
import * as t from "./timing";

describe("timing", () => {
  it("holds the spec 0023 values", () => {
    expect(t.START_DELAY).toBe(300_000);
    expect(t.TARGET).toBe(1_500_000);
    expect(t.HARD_CAP).toBe(7_200_000);
    expect(t.LEASE).toBe(90_000);
    expect(t.START_DELAY).toBeLessThan(t.TARGET);
    expect(t.TARGET).toBeLessThan(t.HARD_CAP);
  });
});
