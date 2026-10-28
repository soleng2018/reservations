import { describe, expect, it } from "vitest";
import { portalOrigin, tenantMatches } from "./portal-host";

describe("portalOrigin", () => {
  it("accepts an https address on an allowed host and returns its origin", () => {
    expect(portalOrigin("https://u1.nile-global.cloud/app?x=1")).toBe(
      "https://u1.nile-global.cloud",
    );
    expect(portalOrigin("https://nile-global.cloud")).toBe(
      "https://nile-global.cloud",
    );
  });

  it.each([
    ["http", "http://u1.nile-global.cloud"],
    ["credentials", "https://a:b@u1.nile-global.cloud"],
    ["another host", "https://u1.example.com"],
    ["a look alike host", "https://evilnile-global.cloud"],
    ["a suffix trick", "https://nile-global.cloud.evil.test"],
    ["not a url", "u1.nile-global.cloud"],
  ])("refuses %s", (_name, url) => {
    expect(portalOrigin(url)).toBeNull();
  });

  it("refuses a missing address", () => {
    expect(portalOrigin(null)).toBeNull();
  });
});

describe("tenantMatches", () => {
  it.each(["Nile Workshop-1", "Nile Workshop 1", "nileworkshop-1"])(
    "%s matches nileworkshop-1.com",
    (name) => {
      expect(tenantMatches(name, "nileworkshop-1.com")).toBe(true);
    },
  );

  it("refuses another workshop and an empty name", () => {
    expect(tenantMatches("Nile Workshop 2", "nileworkshop-1.com")).toBe(false);
    expect(tenantMatches("", "nileworkshop-1.com")).toBe(false);
    expect(tenantMatches("", "")).toBe(false);
  });
});
