import { describe, expect, it } from "vitest";
import { isDenied, normalizePortalRoute } from "./deny-list";

describe("isDenied", () => {
  it.each([
    "/api/v1/idps",
    "/api/v2/idps/{id}",
    "/api/v1/idps?size=10",
    "/api/v1/users/x/roles",
    "/API/V1/USERS",
    "/api/v1/%75sers",
    "/api/v1//users",
    "/api/v1/./users",
    "/api/v1/x/../users",
    "/api/v1/{read.a.b}/../users",
    "/global-settings/identity",
    "/network-setup/users/42",
  ])("refuses %s", (path) => {
    expect(isDenied(path)).toBe(true);
  });

  it.each([
    "/api/v1/userinfo",
    "/api/v1/settings/ssids",
    "/api/v1/idpsx",
    "/api/idps",
    "/network-setup/wireless",
    "/global-settings/integrations",
  ])("allows %s", (path) => {
    expect(isDenied(path)).toBe(false);
  });

  it("matches whole segments, so a longer name is not a prefix match", () => {
    expect(isDenied("/api/v1/users-extra")).toBe(false);
  });
});

describe("normalizePortalRoute", () => {
  it("lowers, decodes once, drops the query, and swaps placeholders", () => {
    expect(normalizePortalRoute("/API/v1/A%2Fb/{id}?x=1")).toEqual([
      "api",
      "v1",
      "a",
      "b",
      "x",
    ]);
  });

  it("keeps a bad percent escape as it is", () => {
    expect(normalizePortalRoute("/api/%zz")).toEqual(["api", "%zz"]);
  });
});
