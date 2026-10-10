import { describe, expect, it } from "vitest";
import { BADGE_TONES, toneFor } from "./badge-tones";

describe("toneFor", () => {
  it.each([
    ["upcoming", "info"],
    ["idp", "info"],
    ["current", "success"],
    ["active", "success"],
    ["ai", "accent"],
    ["past", "neutral"],
    ["inactive", "neutral"],
    ["cancelled", "neutral"],
  ] as const)("gives %s the %s tone", (word, tone) => {
    expect(toneFor(word)).toBe(tone);
  });

  // covers: Value sourcing (DataTable rows), a testbed with no group
  it("gives the testbeds page's Not ready badge the neutral tone", () => {
    expect(toneFor("Not ready")).toBe("neutral");
  });

  it("ignores case and surrounding spaces", () => {
    expect(toneFor("  UPCOMING ")).toBe("info");
    expect(toneFor("Active")).toBe("success");
  });

  it("falls back to neutral for an unknown or empty word", () => {
    expect(toneFor("archived")).toBe("neutral");
    expect(toneFor("")).toBe("neutral");
  });

  it("only ever returns a declared tone", () => {
    const words = ["upcoming", "current", "ai", "past", "whatever"];
    expect(words.every((w) => BADGE_TONES.includes(toneFor(w)))).toBe(true);
  });
});
