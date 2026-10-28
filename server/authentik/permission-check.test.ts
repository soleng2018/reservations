import { describe, expect, it } from "vitest";
import {
  AUTOMATION_PERMISSIONS,
  missingPermissions,
  permissionLine,
} from "@/server/authentik/permission-check";

describe("missingPermissions", () => {
  it("is empty when every permission is held", () => {
    expect(missingPermissions([...AUTOMATION_PERMISSIONS, "x.y"])).toEqual([]);
  });
  it("names the ones that are missing", () => {
    expect(missingPermissions(["authentik_core.add_user"])).toEqual([
      "authentik_core.add_user_to_group",
      "authentik_core.change_user",
      "authentik_core.reset_user_password",
    ]);
  });
});

describe("permissionLine", () => {
  it("is undefined with nothing missing", () => {
    expect(permissionLine([])).toBeUndefined();
  });
  it("lists the missing permissions", () => {
    expect(permissionLine(["a.b"])).toContain("a.b");
  });
});
