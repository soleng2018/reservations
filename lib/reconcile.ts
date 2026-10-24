// Testbed group membership diff (spec 0004 AC-12), the per group work list of
// the access reconciler (spec 0017 AC-10), and the worker's Cloudflare revoke
// state line (spec 0012 AC-11). Pure.

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

// A testbed row as the reconciler reads it.
export type GroupRow = {
  readonly id: string;
  readonly groupName: string;
  readonly groupPk: string;
  readonly deleted: boolean;
};

// Spec 0017 AC-10 (a): one entry per distinct group pk, in first seen order,
// holding every unreleased testbed that points at it. The learners wanted in
// a group are the union over its live rows, so a deleted row adds none and
// the order of the rows never matters.
export function groupByPk(
  rows: readonly GroupRow[],
): readonly { readonly pk: string; readonly rows: readonly GroupRow[] }[] {
  const pks = [...new Set(rows.map((r) => r.groupPk))];
  return pks.map((pk) => ({ pk, rows: rows.filter((r) => r.groupPk === pk) }));
}

// Spec 0017 AC-10 (c): a live testbed's stored pk is stale when the group is
// gone (`undefined`) or its name is no longer the testbed's group name
// (spec 0018 AC-7; the friendly name never matters here).
export const isStalePk = (
  live: Pick<GroupRow, "groupName">,
  group: { readonly name: string } | undefined,
): boolean => group === undefined || group.name !== live.groupName;

export type RevokeKind = "off" | "broken" | "on";

// The worker logs the revoke state on its first run and again only when it
// changes; null means say nothing.
export const revokeStateLine = (
  prev: RevokeKind | undefined,
  next: RevokeKind,
): string | null => (prev === next ? null : `Cloudflare VM revoke is ${next}`);
