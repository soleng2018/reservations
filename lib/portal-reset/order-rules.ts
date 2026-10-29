import type { StepDefinition } from "./step-schema";

// Order the portal does not enforce (spec 0023, decision D7): a policy group
// that matches on a segment survives the segment's delete, because the API
// answers 204 (the page's "Policy Groups are using X" is the page's own
// check). So the list itself must delete the groups first. Judged by what a
// step deletes, not by its name, so a renamed or custom step is covered.
// Safe on both sides.
export const GROUP_DELETE = "/api/v3/policy/groups/";
export const SEGMENT_DELETE = "/api/v1/settings/segments/";

export const ORDER_MESSAGE =
  "Policy groups must be deleted before segments: move the step that deletes segments below the step that deletes policy groups.";

type OrderedStep = {
  readonly enabled: boolean;
  readonly definition: StepDefinition;
};

const deletes = (step: OrderedStep, prefix: string): boolean =>
  step.enabled &&
  step.definition.parts.some(
    (p) => p.kind === "delete_each" && p.delete.path.startsWith(prefix),
  );

// The indexes of the steps that delete segments while a step that deletes
// policy groups comes after them. Empty when the order is safe.
export const unsafeDeleteOrder = (
  steps: readonly OrderedStep[],
): readonly number[] =>
  steps.flatMap((step, i) =>
    deletes(step, SEGMENT_DELETE) &&
    steps.slice(i + 1).some((later) => deletes(later, GROUP_DELETE))
      ? [i]
      : [],
  );
