import { describe, expect, it } from "vitest";
import { durationMs, formatDuration } from "./duration";

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

describe("formatDuration", () => {
  it("uses the singular for one", () => {
    expect(formatDuration(1, "hours")).toBe("1 hour");
    expect(formatDuration(1, "days")).toBe("1 day");
  });

  it("uses the plural otherwise", () => {
    expect(formatDuration(2, "hours")).toBe("2 hours");
    expect(formatDuration(14, "days")).toBe("14 days");
  });
});
