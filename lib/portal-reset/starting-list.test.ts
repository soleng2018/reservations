import { describe, expect, it } from "vitest";
import raw from "@/db/seed/portal-reset-starting-list.json";
import { fieldErrors } from "@/lib/form-errors";
import { isDenied } from "./deny-list";
import { describeStep } from "./describe";
import { guardsForDefinition } from "./guards";
import { StartingList } from "./starting-list";

const parsed = StartingList.parse(raw);

const entry = {
  key: "a",
  featureName: "A",
  parts: [{ kind: "wait", seconds: 1 }],
};
const listOf = (...steps: readonly unknown[]) => ({ schemaVersion: 1, steps });

describe("the starting list file (AC-17, AC-18, AC-21)", () => {
  it("parses, with the 15 tested steps in run order", () => {
    expect(parsed.steps.map((s) => s.key)).toEqual([
      "integrations",
      "ssids",
      "ssid-url-filters",
      "guest-service-auth-geo-control",
      "wired-access-management",
      "policies",
      "service-profiles",
      "policy-groups",
      "segments",
      "authentication-admin-radius-and-guest-portals",
      "nile-radius-policies",
      "nile-radius-certificates",
      "dhcp",
      "guest-portal-branding",
      "users",
    ]);
  });

  it("ships Service Profiles disabled and every other step enabled", () => {
    expect(parsed.steps.filter((s) => !s.enabled).map((s) => s.key)).toEqual([
      "service-profiles",
    ]);
  });

  it("holds no call the deny list refuses, method by method", () => {
    const calls = parsed.steps.flatMap((s) =>
      s.definition.parts.flatMap((p) => {
        switch (p.kind) {
          case "read":
            return [[p.method, p.path]];
          case "delete_each":
            return [
              [p.list.method, p.list.path],
              ["DELETE", p.delete.path],
              ...(p.beforeDelete === undefined
                ? []
                : [[p.beforeDelete.method, p.beforeDelete.path]]),
            ];
          case "call":
            return [[p.method, p.path]];
          case "update_record":
            return [
              [p.list.method, p.list.path],
              ["PUT", p.put.path],
            ];
          case "wait":
          case "expect":
            return [];
        }
      }),
    );
    expect(calls.length).toBeGreaterThan(20);
    expect(calls.filter(([method, path]) => isDenied(path, method))).toEqual(
      [],
    );
  });

  it("holds no page route the deny list refuses", () => {
    const pages = parsed.steps.flatMap((s) => s.definition.pages ?? []);
    expect(pages.filter((page) => isDenied(page))).toEqual([]);
  });

  it("offers the Users step last, with its two guards (spec 0027 AC-11)", () => {
    const users = parsed.steps.find((s) => s.key === "users");
    expect(users?.definition.pages).toBeUndefined();
    expect(
      guardsForDefinition(users?.definition ?? { parts: [] }).map((g) => g.key),
    ).toEqual(["users-root-admin", "users-signed-in"]);
  });

  it("describes every step with one sentence per part", () => {
    parsed.steps.forEach((s) => {
      const lines = describeStep(s.definition);
      expect(lines).toHaveLength(s.definition.parts.length);
      lines.forEach((line) => expect(line).toMatch(/^[A-Z].*\.$/));
    });
  });

  it("shows each guard on the step that reaches it (AC-20)", () => {
    const guardKeys = (key: string) =>
      guardsForDefinition(
        parsed.steps.find((s) => s.key === key)?.definition ?? { parts: [] },
      ).map((g) => g.key);
    expect(guardKeys("ssids")).toEqual(["protected-ssid"]);
    expect(guardKeys("policies")).toEqual(["system-policies"]);
    expect(guardKeys("authentication-admin-radius-and-guest-portals")).toEqual([
      "nile-radius",
    ]);
    expect(guardKeys("nile-radius-policies")).toEqual(["nile-radius-policies"]);
    expect(guardKeys("dhcp")).toEqual(["nile-dhcp"]);
    expect(guardKeys("segments")).toEqual([]);
    expect(guardKeys("integrations")).toEqual([]);
  });
});

describe("the starting list schema", () => {
  it("fails with no entries", () => {
    expect(StartingList.safeParse(listOf()).success).toBe(false);
  });

  it("fails on a repeated key, and on a name repeated ignoring case", () => {
    const keys = StartingList.safeParse(
      listOf(entry, { ...entry, featureName: "B" }),
    );
    expect(keys.success ? null : fieldErrors(keys.error)).toHaveProperty(
      "steps.1",
    );
    const names = StartingList.safeParse(
      listOf(entry, { ...entry, key: "b", featureName: "a" }),
    );
    expect(names.success ? null : fieldErrors(names.error)).toHaveProperty(
      "steps.1",
    );
  });

  it("fails on a key that is not kebab case, and on an unknown field", () => {
    expect(
      StartingList.safeParse(listOf({ ...entry, key: "Not Kebab" })).success,
    ).toBe(false);
    expect(StartingList.safeParse(listOf({ ...entry, extra: 1 })).success).toBe(
      false,
    );
    expect(
      StartingList.safeParse({ ...listOf(entry), schemaVersion: 2 }).success,
    ).toBe(false);
  });

  it("fails on a denied path, keyed by the entry's dotted path", () => {
    const bad = {
      ...entry,
      parts: [{ kind: "call", method: "DELETE", path: "/api/v1/idps/abc" }],
    };
    const result = StartingList.safeParse(listOf(bad));
    expect(result.success ? null : fieldErrors(result.error)).toHaveProperty(
      "steps.0.parts.0.path",
    );
  });
});
