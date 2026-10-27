import { z } from "zod";
import { nameKey } from "./normalize";
import { MAX_STEPS, StepDefinition } from "./step-schema";

// The starting list file (spec 0022 AC-17): `{ schemaVersion: 1, steps }`,
// each entry `{ key, featureName, enabled?, note?, pages?, parts }` in run
// order. The migrate seed step and a test parse it with the same step schema
// a Save uses, plus a unique kebab case `key` per entry. Safe on both sides.
const entryFields = z.strictObject({
  key: z
    .string()
    .max(80)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "A key is kebab case."),
  featureName: z.string().trim().min(1).max(60),
  enabled: z.boolean().optional(),
  note: z.string().trim().max(300).optional(),
  pages: z.unknown().optional(),
  parts: z.unknown(),
});

export const StartingEntry = entryFields.transform((entry, ctx) => {
  const definition = StepDefinition.safeParse({
    parts: entry.parts,
    ...(entry.pages === undefined ? {} : { pages: entry.pages }),
  });
  if (!definition.success) {
    definition.error.issues.forEach((issue) =>
      ctx.addIssue({
        code: "custom",
        message: issue.message,
        path: issue.path,
      }),
    );
    return z.NEVER;
  }
  return {
    key: entry.key,
    featureName: entry.featureName,
    enabled: entry.enabled ?? true,
    note: entry.note ?? null,
    definition: definition.data,
  };
});
export type StartingEntry = z.output<typeof StartingEntry>;

export const StartingList = z
  .strictObject({
    schemaVersion: z.literal(1),
    steps: z.array(StartingEntry).min(1).max(MAX_STEPS),
  })
  .superRefine((file, ctx) => {
    const repeats = (keyOf: (e: StartingEntry) => string, message: string) =>
      file.steps.forEach((entry, i) => {
        const first = file.steps.findIndex((e) => keyOf(e) === keyOf(entry));
        if (first !== i) {
          ctx.addIssue({ code: "custom", message, path: ["steps", i] });
        }
      });
    repeats((e) => e.key, "A key repeats.");
    repeats((e) => nameKey(e.featureName), "A feature name repeats.");
  });
export type StartingList = z.output<typeof StartingList>;
