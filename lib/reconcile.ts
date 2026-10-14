// Pod group membership diff (spec 0004 AC-12), and the worker's Cloudflare
// revoke state line (spec 0012 AC-11). Pure.

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

export type RevokeKind = "off" | "broken" | "on";

// The worker logs the revoke state on its first run and again only when it
// changes; null means say nothing.
export const revokeStateLine = (
  prev: RevokeKind | undefined,
  next: RevokeKind,
): string | null => (prev === next ? null : `Cloudflare VM revoke is ${next}`);
