import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fieldErrors } from "@/lib/form-errors";
import { ORDER_MESSAGE, unsafeDeleteOrder } from "./order-rules";
import { SaveRequest } from "./save-input";
import { StartingEntry } from "./starting-list";
import { StepDefinition } from "./step-schema";

// Spec 0023 decision D7: the portal's API deletes a segment even while a
// policy group matches on it, so the list must delete groups first.
const deleteStep = (listPath: string, deletePath: string, enabled = true) => ({
  enabled,
  definition: StepDefinition.parse({
    parts: [
      {
        kind: "delete_each",
        list: {
          method: "GET",
          path: listPath,
          itemsAt: "content",
          idField: "id",
        },
        delete: { path: deletePath },
      },
    ],
  }),
});
const groups = (enabled = true) =>
  deleteStep(
    "/api/v3/policy/groups?size=2000",
    "/api/v3/policy/groups/{id}",
    enabled,
  );
const segments = (enabled = true) =>
  deleteStep(
    "/api/v1/settings/segments?size=2000",
    "/api/v1/settings/segments/{id}",
    enabled,
  );

describe("unsafeDeleteOrder", () => {
  it("accepts groups before segments, and either alone", () => {
    expect(unsafeDeleteOrder([groups(), segments()])).toEqual([]);
    expect(unsafeDeleteOrder([segments()])).toEqual([]);
    expect(unsafeDeleteOrder([groups()])).toEqual([]);
    expect(unsafeDeleteOrder([])).toEqual([]);
  });

  it("names the segment step that comes before a group step", () => {
    expect(unsafeDeleteOrder([segments(), groups()])).toEqual([0]);
    expect(unsafeDeleteOrder([groups(), segments(), groups()])).toEqual([1]);
  });

  it("ignores a disabled step, which never runs", () => {
    expect(unsafeDeleteOrder([segments(false), groups()])).toEqual([]);
    expect(unsafeDeleteOrder([segments(), groups(false)])).toEqual([]);
  });

  it("holds for the shipped starting list", () => {
    const file = JSON.parse(
      readFileSync("db/seed/portal-reset-starting-list.json", "utf8"),
    ) as { steps: unknown[] };
    const steps = file.steps.map((s) => {
      const entry = StartingEntry.parse(s);
      return { enabled: entry.enabled ?? true, definition: entry.definition };
    });
    expect(steps.some((s) => s.definition.parts.length > 0)).toBe(true);
    expect(unsafeDeleteOrder(steps)).toEqual([]);
  });
});

describe("SaveRequest order rule", () => {
  const draft = (
    name: string,
    s: { definition: unknown; enabled: boolean },
  ) => ({
    featureName: name,
    enabled: s.enabled,
    note: null,
    definition: s.definition,
  });
  const request = (steps: unknown[]) => ({
    expectedVersion: 1,
    abortEmail: null,
    mode: "off",
    steps,
  });

  it("refuses segments before groups with a field error on the segment step", () => {
    const result = SaveRequest.safeParse(
      request([draft("Segments", segments()), draft("Groups", groups())]),
    );
    expect(result.success).toBe(false);
    if (!result.success)
      expect(fieldErrors(result.error)["steps.0.featureName"]).toBe(
        ORDER_MESSAGE,
      );
  });

  it("accepts groups before segments", () => {
    expect(
      SaveRequest.safeParse(
        request([draft("Groups", groups()), draft("Segments", segments())]),
      ).success,
    ).toBe(true);
  });
});
