import { describe, expect, it } from "vitest";
import { initials, initialsOf } from "./initials";

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

// covers: AC-17 (the account menu avatar, spec 0005)
describe("initialsOf (spec 0005 AC-17)", () => {
  it.each([
    ["John Doe", "JD"],
    ["John", "JJ"],
    ["John Singh Pat", "JP"],
  ])("%s is %s", (name, expected) => {
    expect(initialsOf(name)).toBe(expected);
  });

  it("upper cases and ignores extra spaces", () => {
    expect(initialsOf("  ada \t lovelace ")).toBe("AL");
  });

  it("keeps an accented first letter", () => {
    expect(initialsOf("élodie")).toBe("ÉÉ");
  });

  it("gives ? for a blank name", () => {
    expect(initialsOf("")).toBe("?");
    expect(initialsOf("   ")).toBe("?");
  });
});
