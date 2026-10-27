import { describe, expect, it } from "vitest";
import {
  appendEntry,
  checkEntry,
  definitionText,
  entryView,
  isDirty,
  parseDefinitionText,
  removeEntry,
  replaceEntry,
  saveInput,
  startDraft,
  type DraftEntry,
  type Saved,
} from "./draft";
import { SaveRequest } from "./save-input";

const wait = (seconds: number) => ({ parts: [{ kind: "wait", seconds }] });
const saved: Saved = {
  abortEmail: "ops@example.com",
  mode: "off",
  steps: [
    {
      id: "6f1c1b6e-0d57-4b0a-9a53-6a0d4f6f2a01",
      featureName: "One",
      enabled: true,
      note: null,
      definition: wait(1),
    },
    {
      id: "6f1c1b6e-0d57-4b0a-9a53-6a0d4f6f2a02",
      featureName: "Two",
      enabled: false,
      note: "kept",
      definition: wait(2),
    },
  ],
};
const start = startDraft(saved);
const added: DraftEntry = {
  clientKey: "new-1",
  id: null,
  featureName: "Three",
  enabled: true,
  note: null,
  definition: wait(3),
};

describe("draft", () => {
  it("starts from the saved list, one entry per step in order", () => {
    expect(start.steps.map((s) => s.featureName)).toEqual(["One", "Two"]);
    expect(start.abortEmail).toBe("ops@example.com");
    expect(startDraft({ ...saved, abortEmail: null }).abortEmail).toBe("");
  });

  it("adds at the end, replaces by key, and removes by key", () => {
    const grown = appendEntry(start, added);
    expect(grown.steps.map((s) => s.featureName)).toEqual([
      "One",
      "Two",
      "Three",
    ]);
    const renamed = replaceEntry(grown, { ...added, featureName: "Tres" });
    expect(renamed.steps.map((s) => s.featureName)).toEqual([
      "One",
      "Two",
      "Tres",
    ]);
    expect(
      removeEntry(renamed, start.steps[0].clientKey).steps.map(
        (s) => s.featureName,
      ),
    ).toEqual(["Two", "Tres"]);
  });

  it("never changes its input", () => {
    appendEntry(start, added);
    removeEntry(start, start.steps[0].clientKey);
    expect(start.steps).toHaveLength(2);
  });

  it("is dirty only when a Save would send something different", () => {
    expect(isDirty(start, start)).toBe(false);
    expect(isDirty(start, appendEntry(start, added))).toBe(true);
    expect(isDirty(start, { ...start, mode: "dry_run" })).toBe(true);
    expect(isDirty(start, { ...start, abortEmail: "" })).toBe(true);
    // Typed and typed back.
    expect(isDirty(start, { ...start, abortEmail: "ops@example.com" })).toBe(
      false,
    );
    // Same definition with its keys in another order.
    const reordered = replaceEntry(start, {
      ...start.steps[0],
      definition: { parts: [{ seconds: 1, kind: "wait" }] },
    });
    expect(isDirty(start, reordered)).toBe(false);
  });

  it("sends ids for kept rows only and no order numbers", () => {
    const input = saveInput(appendEntry(start, added));
    expect(input.steps.map((s) => "id" in s)).toEqual([true, true, false]);
    expect(JSON.stringify(input)).not.toContain("position");
    expect(JSON.stringify(input)).not.toContain("clientKey");
  });

  it("builds input that a Save accepts", () => {
    const parsed = SaveRequest.safeParse({
      ...saveInput(appendEntry(start, added)),
      expectedVersion: 1,
    });
    expect(parsed.success).toBe(true);
  });

  it("shows a draft row with its place, and an unparsed one as invalid", () => {
    const view = entryView(added, 2);
    expect(view.position).toBe(3);
    expect(view.invalid).toBe(false);
    expect(view.description).toHaveLength(1);
    expect(entryView({ ...added, definition: { nope: 1 } }, 0).invalid).toBe(
      true,
    );
  });
});

describe("parseDefinitionText", () => {
  it("round trips a definition through its text", () => {
    const parsed = parseDefinitionText(definitionText(wait(5)));
    expect(parsed).toEqual({ ok: true, value: wait(5) });
  });

  it("says when the text is not JSON", () => {
    const parsed = parseDefinitionText("{ parts: ");
    expect(parsed).toEqual({
      ok: false,
      error: { "": "This is not valid JSON." },
    });
  });

  it("keys a schema problem by its dotted path", () => {
    const parsed = parseDefinitionText(
      JSON.stringify({
        parts: [{ kind: "call", method: "DELETE", path: "/api/v1/idps/x" }],
      }),
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(Object.keys(parsed.error)).toContain("parts.0.path");
    }
  });

  it("refuses a wait over 60 seconds", () => {
    const parsed = parseDefinitionText(JSON.stringify(wait(61)));
    expect(parsed.ok).toBe(false);
  });
});

describe("checkEntry", () => {
  const input = {
    featureName: "  New step ",
    enabled: true,
    note: "",
    definitionText: definitionText(wait(2)),
  };

  it("normalizes a good row", () => {
    const checked = checkEntry(input, start.steps);
    expect(checked).toEqual({
      ok: true,
      value: {
        featureName: "New step",
        enabled: true,
        note: null,
        definition: wait(2),
      },
    });
  });

  it("refuses a repeated name ignoring case, and an empty one", () => {
    const repeated = checkEntry({ ...input, featureName: "tWo" }, start.steps);
    expect(repeated).toEqual({
      ok: false,
      error: { featureName: "Another step already has this name." },
    });
    const empty = checkEntry({ ...input, featureName: "  " }, start.steps);
    expect(empty.ok).toBe(false);
  });

  it("lets a row keep its own name when it is left out of the others", () => {
    const [one, two] = start.steps;
    expect(checkEntry({ ...input, featureName: "One" }, [two]).ok).toBe(true);
    expect(checkEntry({ ...input, featureName: "One" }, [one, two]).ok).toBe(
      false,
    );
  });

  it("keys definition problems under definition, and name problems apart", () => {
    const bad = checkEntry(
      {
        ...input,
        featureName: "",
        note: "x".repeat(301),
        definitionText: JSON.stringify(wait(61)),
      },
      start.steps,
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      const keys = Object.keys(bad.error);
      expect(keys).toContain("featureName");
      expect(keys).toContain("note");
      expect(keys.some((k) => k.startsWith("definition."))).toBe(true);
    }
  });

  it("reports unreadable text as one definition error and nothing spurious", () => {
    const bad = checkEntry({ ...input, definitionText: "{" }, start.steps);
    expect(bad).toEqual({
      ok: false,
      error: { definition: "This is not valid JSON." },
    });
  });
});
