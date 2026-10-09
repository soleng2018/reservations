import { describe, expect, it } from "vitest";
import { membershipDiff } from "./reconcile";

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
