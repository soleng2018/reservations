import { describe, expect, it } from "vitest";
import {
  computeDiff,
  emailChange,
  emailSummary,
  modeSummary,
  type CurrentStep,
  type DraftRow,
  type Settings,
} from "./diff";

const def = (seconds: number) => ({ parts: [{ kind: "wait", seconds }] });
const cur = (id: string, name = id.toUpperCase()): CurrentStep => ({
  id,
  featureName: name,
  enabled: true,
  note: null,
  definition: def(1),
});
const keep = (c: CurrentStep, over: Partial<DraftRow> = {}): DraftRow => ({
  id: c.id,
  featureName: c.featureName,
  enabled: c.enabled,
  note: c.note,
  definition: c.definition,
  ...over,
});
const same: Settings = { abortEmail: null, mode: "off" };
const diff = (
  current: readonly CurrentStep[],
  draft: readonly DraftRow[],
  after = same,
) => computeDiff(current, draft, same, after);

const [a, b, c, d] = [cur("a"), cur("b"), cur("c"), cur("d")] as const;

describe("computeDiff", () => {
  it("is no change for the same list", () => {
    const result = diff([a, b], [keep(a), keep(b)]);
    expect(result.hasChanges).toBe(false);
    expect(result).toMatchObject({
      added: [],
      updated: [],
      removed: [],
      reordered: null,
      email: null,
      mode: null,
    });
  });

  it("is no change when the definition differs only by key order", () => {
    const x = {
      ...a,
      definition: { pages: ["/p"], parts: [{ seconds: 1, kind: "wait" }] },
    };
    const y = keep(x, {
      definition: { parts: [{ kind: "wait", seconds: 1 }], pages: ["/p"] },
    });
    expect(diff([x], [y]).hasChanges).toBe(false);
  });

  it("finds an added row and its place", () => {
    const result = diff(
      [a, b],
      [
        keep(a),
        { featureName: "New", enabled: true, note: null, definition: def(2) },
        keep(b),
      ],
    );
    expect(result.added.map((r) => [r.index, r.row.featureName])).toEqual([
      [1, "New"],
    ]);
    expect(result.reordered).toBeNull();
    expect(result.hasChanges).toBe(true);
  });

  it("finds a removed row, and a removal that shifts the others is not a reorder", () => {
    const result = diff([a, b, c], [keep(a), keep(c)]);
    expect(result.removed.map((r) => r.id)).toEqual(["b"]);
    expect(result.reordered).toBeNull();
  });

  it("finds an updated row with the changed fields only", () => {
    const result = diff([a], [keep(a, { featureName: "Renamed", note: "n" })]);
    expect(result.updated).toHaveLength(1);
    expect(result.updated[0]?.changed).toEqual({
      featureName: { from: "A", to: "Renamed" },
      note: { from: null, to: "n" },
    });
    expect(result.updated[0]?.summary).toBe("Updated step Renamed");
  });

  it("says Disabled or Enabled when the flag is the only change", () => {
    expect(diff([a], [keep(a, { enabled: false })]).updated[0]?.summary).toBe(
      "Disabled step A",
    );
    const off = { ...a, enabled: false };
    expect(
      diff([off], [keep(off, { enabled: true })]).updated[0]?.summary,
    ).toBe("Enabled step A");
  });

  it("holds the full before and after of a changed definition", () => {
    const result = diff([a], [keep(a, { definition: def(5) })]);
    expect(result.updated[0]?.changed.definition).toEqual({
      from: def(1),
      to: def(5),
    });
  });

  it("finds a reorder among the surviving rows", () => {
    const result = diff([a, b, c, d], [keep(c), keep(a), keep(b), keep(d)]);
    expect(result.reordered).toEqual({
      before: ["A", "B", "C", "D"],
      after: ["C", "A", "B", "D"],
      moved: 3,
    });
  });

  it("finds a reorder that comes with a removal and an add", () => {
    const result = diff(
      [a, b, c],
      [
        keep(c),
        { featureName: "N", enabled: true, note: null, definition: def(1) },
        keep(a),
      ],
    );
    expect(result.removed.map((r) => r.id)).toEqual(["b"]);
    expect(result.reordered?.before).toEqual(["A", "C"]);
    expect(result.reordered?.after).toEqual(["C", "A"]);
  });

  it("finds a swap of two names as two updates, no reorder", () => {
    const result = diff(
      [a, b],
      [keep(a, { featureName: "B" }), keep(b, { featureName: "A" })],
    );
    expect(result.updated).toHaveLength(2);
    expect(result.reordered).toBeNull();
  });

  it("finds an email and a mode change", () => {
    const result = diff([a], [keep(a)], {
      abortEmail: "ops@example.com",
      mode: "live",
    });
    expect(result.email).toEqual({ change: "set", domain: "example.com" });
    expect(result.mode).toEqual({ from: "off", to: "live" });
    expect(result.hasChanges).toBe(true);
  });
});

describe("emailChange", () => {
  it("says set, cleared, or changed, with the domain and never the address", () => {
    expect(emailChange(null, "a@x.io")).toEqual({
      change: "set",
      domain: "x.io",
    });
    expect(emailChange("a@x.io", null)).toEqual({
      change: "cleared",
      domain: null,
    });
    expect(emailChange("a@x.io", "b@y.io")).toEqual({
      change: "changed",
      domain: "y.io",
    });
    expect(emailChange("a@x.io", "a@x.io")).toBeNull();
    expect(JSON.stringify(emailChange(null, "secret.name@x.io"))).not.toContain(
      "secret.name",
    );
  });

  it("words the summaries", () => {
    expect(emailSummary({ change: "set", domain: "x.io" })).toBe(
      "Abort email set",
    );
    expect(emailSummary({ change: "cleared", domain: null })).toBe(
      "Abort email cleared",
    );
    expect(emailSummary({ change: "changed", domain: "x.io" })).toBe(
      "Abort email changed",
    );
    expect(modeSummary("off", "dry_run")).toBe(
      "Mode changed from off to dry run",
    );
  });
});
