import { LockIcon, UsersIcon } from "lucide-react";
import { describe, expect, it } from "vitest";
import {
  ADMIN_NAV,
  ADMIN_SECTIONS,
  activeSection,
  navItem,
  type AdminSection,
} from "./admin-nav";

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

  // covers: Value sourcing (admin shell), every section has exactly one item,
  // so navItem never throws for a typed section
  it("has one item per section, in ADMIN_SECTIONS order", () => {
    expect(ADMIN_NAV.map((i) => i.section)).toEqual([...ADMIN_SECTIONS]);
  });

  it("links each item to its own section path", () => {
    expect(ADMIN_NAV.every((i) => i.href === `/admin/${i.section}`)).toBe(true);
  });

  // covers: AC-3, the page header subtitles from the mock
  it("carries the mock's subtitles", () => {
    expect(
      Object.fromEntries(ADMIN_NAV.map((i) => [i.section, i.subtitle])),
    ).toEqual({
      "api-keys":
        "Credentials used to connect testbeds to identity providers and AI services.",
      "testbed-types":
        "Lab difficulty levels and how long each reservation lasts.",
      testbeds: "The remote labs customers can reserve.",
      users: "Everyone with hands-on lab access.",
    });
  });

  // covers: AC-5, Value sourcing (placeholder pages reuse the nav icon)
  it("uses the lock icon for API Keys and the users icon for Users", () => {
    expect(navItem("api-keys").icon).toBe(LockIcon);
    expect(navItem("users").icon).toBe(UsersIcon);
  });

  it("throws for a section missing from the nav (a broken invariant)", () => {
    expect(() => navItem("billing" as AdminSection)).toThrow(
      "ADMIN_NAV has no billing",
    );
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
