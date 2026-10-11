import { describe, expect, it } from "vitest";
import type { TestbedTypeInput } from "./catalog-input";
import { changedFields } from "./changed-fields";

// Audit metadata for edits (features 7 and 8).
describe("changedFields", () => {
  const KEYS = ["name", "durationValue", "durationUnit"] as const;
  const before: TestbedTypeInput = {
    name: "Basic",
    durationValue: 2,
    durationUnit: "hours",
  };

  it("is empty when nothing changed", () => {
    expect(changedFields(KEYS, before, { ...before })).toEqual({});
  });

  it("lists only the changed fields, with from and to", () => {
    expect(
      changedFields(KEYS, before, {
        ...before,
        durationValue: 3,
        durationUnit: "days",
      }),
    ).toEqual({
      durationValue: { from: 2, to: 3 },
      durationUnit: { from: "hours", to: "days" },
    });
  });

  it("counts a change of case in the name as a change", () => {
    expect(changedFields(KEYS, before, { ...before, name: "BASIC" })).toEqual({
      name: { from: "Basic", to: "BASIC" },
    });
  });

  it("ignores fields it was not given, such as a secret", () => {
    const key = { name: "Okta", type: "IDP", baseUrl: "https://a.example" };
    const edited = { ...key, secret: "never audited" };
    expect(changedFields(["name", "type", "baseUrl"], key, edited)).toEqual({});
  });
});
