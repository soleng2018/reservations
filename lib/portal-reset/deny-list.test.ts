import { describe, expect, it } from "vitest";
import { isDenied, normalizePortalRoute } from "./deny-list";

// covers: AC-19
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

// covers: spec 0027 AC-1, AC-2
describe("isDenied with a method (the Users allow list)", () => {
  it.each([
    ["GET", "/api/v2/users"],
    ["GET", "/api/v2/users?page=0&size=2000"],
    ["POST", "/api/v1/users/abc/lifecycle/deactivate"],
    ["POST", "/api/v1/users/{id}/lifecycle/deactivate"],
    ["DELETE", "/api/v1/users/abc"],
    ["DELETE", "/api/v1/users/{id}"],
  ])("lets %s %s through", (method, path) => {
    expect(isDenied(path, method)).toBe(false);
  });

  it.each([
    ["POST", "/api/v2/users"],
    ["PUT", "/api/v2/users"],
    ["GET", "/api/v1/users"],
    ["POST", "/api/v1/users"],
    ["GET", "/api/v1/users/abc"],
    ["PUT", "/api/v1/users/abc"],
    ["GET", "/api/v1/users/abc/lifecycle/deactivate"],
    ["DELETE", "/api/v1/users/abc/lifecycle/deactivate"],
    ["POST", "/api/v1/users/abc/tags"],
    ["DELETE", "/api/v1/users/abc/tags"],
    ["POST", "/api/v1/users/abc/lifecycle/activate"],
    ["POST", "/api/v1/users/abc/reset-password"],
    ["DELETE", "/api/v1/idps/abc"],
    ["GET", "/api/v1/idps"],
    ["GET", "/global-settings/identity"],
    ["GET", "/network-setup/users"],
    ["DELETE", "/api/v1/users/abc/lifecycle/deactivate/extra"],
  ])("still refuses %s %s", (method, path) => {
    expect(isDenied(path, method)).toBe(true);
  });

  it("refuses all of them with no method, so pages and discovery stay denied", () => {
    expect(isDenied("/api/v2/users")).toBe(true);
    expect(isDenied("/api/v1/users/abc")).toBe(true);
    expect(isDenied("/api/v1/users/abc/lifecycle/deactivate")).toBe(true);
  });

  it("normalises the route before it matches an entry", () => {
    expect(isDenied("/API/V1/%75sers/abc", "DELETE")).toBe(false);
    expect(isDenied("/api/v1/x/../users/abc/tags", "DELETE")).toBe(true);
    expect(isDenied("/api/v1/users/abc/../../idps", "DELETE")).toBe(true);
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
