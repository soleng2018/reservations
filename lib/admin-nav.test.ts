import { describe, expect, it } from "vitest";
import { ADMIN_NAV, activeSection, navItem } from "./admin-nav";

describe("ADMIN_NAV", () => {
  it("lists the sections in the mock's order", () => {
    expect(ADMIN_NAV.map((i) => i.label)).toEqual([
      "API Keys",
      "Testbed Types",
      "Testbeds",
      "Users",
    ]);
  });

  it("finds an item by section", () => {
    expect(navItem("testbeds").href).toBe("/admin/testbeds");
  });
});

describe("activeSection", () => {
  it("matches a section's own path", () => {
    expect(activeSection("/admin/testbed-types")).toBe("testbed-types");
  });

  it("keeps the section active on nested paths", () => {
    expect(activeSection("/admin/users/42")).toBe("users");
  });

  it("does not confuse testbeds with testbed-types", () => {
    expect(activeSection("/admin/testbeds")).toBe("testbeds");
    expect(activeSection("/admin/testbed-types/x")).toBe("testbed-types");
  });

  it("is undefined outside the nav", () => {
    expect(activeSection("/admin/ui-gallery")).toBeUndefined();
    expect(activeSection("/admin")).toBeUndefined();
  });
});
