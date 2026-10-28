import { describe, expect, it } from "vitest";
import { fieldErrors } from "@/lib/form-errors";
import { SaveRequest } from "./save-input";

const wait = { parts: [{ kind: "wait", seconds: 1 }] };
const step = (over: Record<string, unknown> = {}) => ({
  featureName: "A",
  enabled: true,
  note: null,
  definition: wait,
  ...over,
});
const request = (over: Record<string, unknown> = {}) => ({
  expectedVersion: 1,
  abortEmail: "ops@example.com",
  mode: "off",
  steps: [step()],
  ...over,
});
const errors = (input: unknown) => {
  const result = SaveRequest.safeParse(input);
  return result.success ? null : fieldErrors(result.error);
};

describe("SaveRequest (AC-9)", () => {
  it("refuses a list too large for a Server Action, with a field error", () => {
    // Each definition is under its own 20 000 character cap (about 17 000).
    const heavy = {
      parts: [
        {
          kind: "call",
          method: "PUT",
          path: "/api/v1/x",
          body: { a: Array.from({ length: 400 }, () => "x".repeat(40)) },
        },
      ],
    };
    const steps = Array.from({ length: 40 }, (_, i) =>
      step({ featureName: `Heavy ${i}`, definition: heavy }),
    );
    expect(errors(request({ steps: steps.slice(0, 20) }))).toBeNull();
    expect(errors(request({ steps }))?.steps).toMatch(/too large/);
  });

  it("accepts a valid Save", () => {
    expect(errors(request())).toBeNull();
  });

  it("normalizes: trims, empty to null, lowercases the email", () => {
    const parsed = SaveRequest.parse(
      request({
        abortEmail: "  Ops@Example.COM ",
        steps: [step({ featureName: "  SSIDs ", note: "   " })],
      }),
    );
    expect(parsed.abortEmail).toBe("ops@example.com");
    expect(parsed.steps[0]).toMatchObject({ featureName: "SSIDs", note: null });
  });

  it("allows an empty or missing email (AC-10)", () => {
    expect(
      SaveRequest.parse(request({ abortEmail: "" })).abortEmail,
    ).toBeNull();
    expect(
      SaveRequest.parse(request({ abortEmail: null })).abortEmail,
    ).toBeNull();
    const without = Object.fromEntries(
      Object.entries(request()).filter(([key]) => key !== "abortEmail"),
    );
    expect(SaveRequest.parse(without).abortEmail).toBeNull();
  });

  it.each([
    ["a bad email", { abortEmail: "not an email" }, "abortEmail"],
    [
      "an email over 254 characters",
      { abortEmail: `${"a".repeat(250)}@x.io` },
      "abortEmail",
    ],
    ["a bad mode", { mode: "on" }, "mode"],
    ["no rows", { steps: [] }, "steps"],
    [
      "101 rows",
      {
        steps: Array.from({ length: 101 }, (_, i) =>
          step({ featureName: `S${i}` }),
        ),
      },
      "steps",
    ],
    ["a version of 0", { expectedVersion: 0 }, "expectedVersion"],
    [
      "an empty name",
      { steps: [step({ featureName: "  " })] },
      "steps.0.featureName",
    ],
    [
      "a name over 60 characters",
      { steps: [step({ featureName: "x".repeat(61) })] },
      "steps.0.featureName",
    ],
    [
      "a note over 300 characters",
      { steps: [step({ note: "n".repeat(301) })] },
      "steps.0.note",
    ],
    [
      "a name repeated ignoring case",
      { steps: [step(), step({ featureName: " a " })] },
      "steps.1.featureName",
    ],
    [
      "no parts",
      { steps: [step({ definition: { parts: [] } })] },
      "steps.0.definition.parts",
    ],
    [
      "a path with a host",
      {
        steps: [
          step({
            definition: {
              parts: [
                { kind: "call", method: "PUT", path: "https://x.io/api/v1/a" },
              ],
            },
          }),
        ],
      },
      "steps.0.definition.parts.0.path",
    ],
    [
      "a delete path with a query",
      {
        steps: [
          step({
            definition: {
              parts: [
                {
                  kind: "delete_each",
                  list: {
                    method: "GET",
                    path: "/api/v1/a",
                    itemsAt: "$",
                    idField: "id",
                  },
                  delete: { path: "/api/v1/a/{id}?x=1" },
                },
              ],
            },
          }),
        ],
      },
      "steps.0.definition.parts.0.delete.path",
    ],
    [
      "an id that is not a uuid",
      { steps: [step({ id: "abc" })] },
      "steps.0.id",
    ],
  ])("refuses %s, keyed by its dotted path", (_why, over, path) => {
    expect(errors(request(over))).toHaveProperty(path);
  });

  it("refuses an unknown field, so nothing rides along", () => {
    expect(errors({ ...request(), extra: 1 })).not.toBeNull();
    expect(errors(request({ steps: [step({ position: 3 })] }))).not.toBeNull();
  });

  it("never sends the position: the server sets it from the index", () => {
    const parsed = SaveRequest.parse(request());
    expect(Object.keys(parsed.steps[0] ?? {})).not.toContain("position");
  });
});
