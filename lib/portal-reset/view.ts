import { describeStep } from "./describe";
import { guardsForDefinition } from "./guards";
import type { StepDefinition } from "./step-schema";

// One step as the page shows it: plain strings only, built on the server
// (spec 0022 AC-4, AC-20, AC-24). Safe on both sides.
export type ResetRowView = {
  readonly id: string;
  readonly position: number;
  readonly featureName: string;
  readonly enabled: boolean;
  readonly note: string | null;
  // One sentence per part. Empty when the definition no longer parses.
  readonly description: readonly string[];
  // The guard lines that apply, each a rule that no edit can remove.
  readonly guardLines: readonly string[];
  readonly invalid: boolean;
};

type Source = {
  readonly id: string;
  readonly position: number;
  readonly featureName: string;
  readonly enabled: boolean;
  readonly note: string | null;
};

export const rowView = (
  step: Source,
  definition: StepDefinition | null,
): ResetRowView => ({
  id: step.id,
  position: step.position,
  featureName: step.featureName,
  enabled: step.enabled,
  note: step.note,
  description: definition === null ? [] : describeStep(definition),
  guardLines:
    definition === null
      ? []
      : guardsForDefinition(definition).map((g) => g.line),
  invalid: definition === null,
});
