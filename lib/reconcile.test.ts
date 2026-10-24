import { describe, expect, it } from "vitest";
import {
  membershipDiff,
  revokeStateLine,
  groupByPk,
  isStalePk,
  type GroupRow,
} from "./reconcile";

// covers: AC-12
describe("membershipDiff (AC-12)", () => {
  it("adds the Current learner, removes an ended tagged one, keeps untagged", () => {
    expect(
      membershipDiff(new Set([3, 4]), [
        { pk: 4, holLearner: true }, // still Current
        { pk: 5, holLearner: true }, // ended
        { pk: 9, holLearner: false }, // staff or a manual member
      ]),
    ).toEqual({ add: [3], remove: [5] });
  });

  it("empties a group of tagged learners when nothing is desired", () => {
    expect(
      membershipDiff(new Set(), [
        { pk: 1, holLearner: true },
        { pk: 2, holLearner: false },
      ]),
    ).toEqual({ add: [], remove: [1] });
  });
});

// covers: spec 0012 AC-11
describe("revokeStateLine (spec 0012 AC-11)", () => {
  it("says the state on the first run and again only when it changes", () => {
    const kinds = ["off", "on", "on", "broken"] as const;
    const lines = kinds.map((next, i) =>
      revokeStateLine(i === 0 ? undefined : kinds[i - 1], next),
    );
    expect(lines).toEqual([
      "Cloudflare VM revoke is off",
      "Cloudflare VM revoke is on",
      null,
      "Cloudflare VM revoke is broken",
    ]);
  });
});

const row = (id: string, groupPk: string, deleted = false): GroupRow => ({
  id,
  name: `Name ${id}`,
  groupPk,
  deleted,
});

// covers: spec 0017 AC-10 (a), one work item per distinct group pk
describe("groupByPk (spec 0017 AC-10)", () => {
  it("makes one entry per pk, in first seen order, holding every row on it", () => {
    const rows = [row("a", "g1"), row("b", "g2"), row("c", "g1", true)];
    expect(groupByPk(rows)).toEqual([
      { pk: "g1", rows: [rows[0], rows[2]] },
      { pk: "g2", rows: [rows[1]] },
    ]);
  });

  it("keeps a deleted row and a live row on one pk together, in either order", () => {
    const live = row("live", "g1");
    const gone = row("gone", "g1", true);
    expect(groupByPk([gone, live])[0]?.rows).toEqual([gone, live]);
    expect(groupByPk([live, gone])[0]?.rows).toEqual([live, gone]);
  });

  it("is empty for no rows", () => {
    expect(groupByPk([])).toEqual([]);
  });
});

// covers: spec 0017 AC-10 (c), when a stored pk is stale
describe("isStalePk (spec 0017 AC-10)", () => {
  const live = { name: "NileWorkshop1Admin" };

  it("is stale when the group is gone", () => {
    expect(isStalePk(live, undefined)).toBe(true);
  });

  it("is stale when the group's name is no longer the testbed's, in any case", () => {
    expect(isStalePk(live, { name: "Renamed" })).toBe(true);
    expect(isStalePk(live, { name: "nileworkshop1admin" })).toBe(true);
  });

  it("is not stale when the name is exactly the testbed's", () => {
    expect(isStalePk(live, { name: "NileWorkshop1Admin" })).toBe(false);
  });
});
