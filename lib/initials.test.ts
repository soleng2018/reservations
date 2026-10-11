import { describe, expect, it } from "vitest";
import { initials } from "./initials";

// covers: AC-2 (the avatar on the user detail page)
describe("initials (AC-2)", () => {
  it("takes the first letters of the first and last words", () => {
    expect(initials("Priya Shah")).toBe("PS");
  });

  it("skips middle words", () => {
    expect(initials("Priya Anne Shah")).toBe("PS");
  });

  it("gives one letter for a one word name", () => {
    expect(initials("Cher")).toBe("C");
  });

  it("ignores extra spaces around and between words", () => {
    expect(initials("  priya \t  shah  ")).toBe("PS");
  });

  it("uppercases, accented letters included", () => {
    expect(initials("élodie durand")).toBe("ÉD");
  });

  it("returns an empty string for a blank name", () => {
    expect(initials("   ")).toBe("");
  });
});
