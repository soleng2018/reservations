// The fields an edit changed, as { field: { from, to } }, for audit
// metadata. Empty when the edit changed nothing. Only `keys` are compared,
// so a field that must never be audited (a secret) is simply not listed.
// Safe on both sides.
export const changedFields = <K extends string>(
  keys: readonly K[],
  before: Readonly<Record<K, unknown>>,
  after: Readonly<Record<K, unknown>>,
): Readonly<Record<string, { readonly from: unknown; readonly to: unknown }>> =>
  Object.fromEntries(
    keys
      .filter((k) => before[k] !== after[k])
      .map((k) => [k, { from: before[k], to: after[k] }]),
  );
