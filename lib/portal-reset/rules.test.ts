import { describe, expect, it } from "vitest";
import {
  evaluateConds,
  evaluateRules,
  listItems,
  pickScalars,
  selectForDelete,
} from "./rules";
import type { Rule } from "./step-schema";

// covers: AC-20
describe("evaluateRules", () => {
  const item = { a: { isDefault: true }, n: 3, list: [1], empty: [], x: null };
  const cases: readonly (readonly [Rule, boolean])[] = [
    [{ field: "a.isDefault", op: "eq", value: true }, true],
    [{ field: "a.isDefault", op: "ne", value: true }, false],
    [{ field: "n", op: "in", value: [1, 3] }, true],
    [{ field: "x", op: "exists" }, false],
    [{ field: "x", op: "missing" }, true],
    [{ field: "nope", op: "missing" }, true],
    [{ field: "list", op: "nonEmpty" }, true],
    [{ field: "empty", op: "nonEmpty" }, false],
  ];
  it.each(cases)("%j gives %s", (rule, expected) => {
    expect(evaluateRules(item, [rule])).toBe(expected);
  });

  it("is a conjunction, and an empty list holds", () => {
    expect(evaluateRules(item, [])).toBe(true);
    expect(
      evaluateRules(item, [
        { field: "n", op: "eq", value: 3 },
        { field: "n", op: "eq", value: 4 },
      ]),
    ).toBe(false);
  });
});

describe("evaluateConds and pickScalars", () => {
  const reads = { wired: { sso: true, name: "x" } };
  it("tests kept values, and a missing read tests as missing", () => {
    expect(evaluateConds(reads, undefined)).toBe(true);
    expect(
      evaluateConds(reads, [
        { read: "wired", key: "sso", op: "eq", value: true },
      ]),
    ).toBe(true);
    expect(
      evaluateConds(reads, [{ read: "other", key: "sso", op: "exists" }]),
    ).toBe(false);
    expect(
      evaluateConds(reads, [
        { read: "constructor", key: "name", op: "exists" },
      ]),
    ).toBe(false);
  });
  it("keeps scalars only", () => {
    expect(
      pickScalars(
        { a: { b: 1 }, c: { d: 1 }, e: "t" },
        { one: "a.b", obj: "c", str: "e", gone: "z" },
      ),
    ).toEqual({ one: 1, str: "t" });
  });
});

describe("listItems and selectForDelete", () => {
  const spec = { itemsAt: "content", idField: "id", labelField: "name" };
  it("reads ids and labels, and numbers become text", () => {
    const r = listItems({ content: [{ id: 7, name: "A" }, { id: "b" }] }, spec);
    expect(r.ok && r.value.map((i) => [i.id, i.label])).toEqual([
      ["7", "A"],
      ["b", null],
    ]);
  });
  it("is bad_shape when itemsAt is not an array or an id is missing", () => {
    expect(listItems({ content: {} }, spec)).toEqual({
      ok: false,
      error: "bad_shape",
    });
    expect(listItems({ content: [{ name: "A" }] }, spec).ok).toBe(false);
  });
  it("unwraps and flattens nested records with the parent id", () => {
    const r = listItems(
      [{ id: "p1", policies: [{ id: "r1" }, { id: "r2" }] }, { id: "p2" }],
      {
        itemsAt: "$",
        idField: "id",
        nested: { at: "policies", parentIdField: "id" },
      },
    );
    expect(r.ok && r.value.map((i) => [i.parentId, i.id])).toEqual([
      ["p1", "r1"],
      ["p1", "r2"],
    ]);
    const u = listItems([{ clientConfig: { id: "c" } }], {
      itemsAt: "$",
      idField: "id",
      unwrap: "clientConfig",
    });
    expect(u.ok && u.value[0]?.id).toBe("c");
  });
  it("drops skipped items and keeps only onlyWhen matches", () => {
    const r = listItems(
      {
        content: [
          { id: "1", d: true },
          { id: "2", d: false },
        ],
      },
      spec,
    );
    const items = r.ok ? r.value : [];
    expect(
      selectForDelete(items, {
        skipWhen: [{ field: "d", op: "eq", value: true }],
      }).map((i) => i.id),
    ).toEqual(["2"]);
    expect(
      selectForDelete(items, {
        onlyWhen: [{ field: "d", op: "eq", value: true }],
      }).map((i) => i.id),
    ).toEqual(["1"]);
  });
});
