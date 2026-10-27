import { describeStep } from "./describe";
import type { StartingChoice } from "./draft";
import type { StartingList } from "./starting-list";

// The starting list entries the page offers (spec 0022 AC-13): those whose key
// is not the `seed_key` of a stored row, in file order. A row that was removed
// and saved is gone from the table, so its entry is offered again (AC-26).
// Pure; safe on both sides.
export const startingChoices = (
  list: StartingList,
  storedKeys: readonly (string | null)[],
): readonly StartingChoice[] => {
  const stored = new Set(storedKeys);
  return list.steps
    .filter((entry) => !stored.has(entry.key))
    .map((entry) => ({
      key: entry.key,
      featureName: entry.featureName,
      enabled: entry.enabled,
      note: entry.note,
      definition: entry.definition,
      description: describeStep(entry.definition),
    }));
};
