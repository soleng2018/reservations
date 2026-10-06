import { describe, expect, it } from "vitest";
import { durationMs } from "./duration";

describe("durationMs", () => {
  it("converts hours", () => {
    expect(durationMs(2, "hours")).toBe(2 * 3_600_000);
  });

  it("treats a day as a fixed 24 hours", () => {
    expect(durationMs(3, "days")).toBe(72 * 3_600_000);
  });

  it.each([0, -1, 1.5, Number.NaN])("throws on %s", (value) => {
    expect(() => durationMs(value, "hours")).toThrow();
  });
});
