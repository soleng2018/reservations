import { describe, expect, it } from "vitest";
import { SLUG_MAX, slugCandidate, slugify } from "./slug";

const FORMAT = /^[a-z0-9]+(-[a-z0-9]+)*$/;

describe("slugify", () => {
  it.each([
    ["Lab A", "lab-a"],
    ["  Nile  Pod #3 ", "nile-pod-3"],
    ["Café Wi-Fi", "cafe-wi-fi"],
    ["---", "testbed"],
    ["日本", "testbed"],
    ["", "testbed"],
  ])("%j → %j", (name, slug) => {
    expect(slugify(name)).toBe(slug);
  });

  it("cuts to the max length without a trailing hyphen", () => {
    const slug = slugify(`${"a".repeat(49)} bcd`);
    expect(slug).toBe("a".repeat(49));
    expect(slug).toMatch(FORMAT);
  });
});

describe("slugCandidate", () => {
  it("returns the base for the first attempt", () => {
    expect(slugCandidate("lab-a", 1)).toBe("lab-a");
  });

  it("appends the attempt number", () => {
    expect(slugCandidate("lab-a", 2)).toBe("lab-a-2");
    expect(slugCandidate("lab-a", 10)).toBe("lab-a-10");
  });

  it("keeps a suffixed long slug within the limit and format", () => {
    const base = slugify("x".repeat(48) + " y");
    const slug = slugCandidate(base, 12);
    expect(slug.length).toBeLessThanOrEqual(SLUG_MAX);
    expect(slug).toMatch(FORMAT);
    expect(slug.endsWith("-12")).toBe(true);
  });
});
