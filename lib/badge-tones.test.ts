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

// covers: spec 0013 AC-21
describe("email status tones (spec 0013 AC-21)", () => {
  it.each([
    ["Queued", "info"],
    ["Sent", "success"],
    ["Failed", "accent"],
    ["Suppressed", "neutral"],
  ])("%s wears %s", (word, tone) => {
    expect(toneFor(word)).toBe(tone);
  });
});
