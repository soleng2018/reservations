// Pod group membership diff (spec 0004 AC-12). Pure.

export type Member = { readonly pk: number; readonly holLearner: boolean };

// Adds every desired learner who is not a member; removes only tagged
// learners who are no longer desired. Untagged members are never touched.
export function membershipDiff(
  desired: ReadonlySet<number>,
  actual: readonly Member[],
): { readonly add: readonly number[]; readonly remove: readonly number[] } {
  const present = new Set(actual.map((m) => m.pk));
  return {
    add: [...desired].filter((pk) => !present.has(pk)).sort((a, b) => a - b),
    remove: actual
      .filter((m) => m.holLearner && !desired.has(m.pk))
      .map((m) => m.pk),
  };
}
