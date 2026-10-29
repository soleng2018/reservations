import { z } from "zod";
import { PortalResetMode } from "@/lib/db-enums";
import { nameKey, normalizeEmail, nullIfEmpty, trimmed } from "./normalize";
import { ORDER_MESSAGE, unsafeDeleteOrder } from "./order-rules";
import { MAX_STEPS, StepDefinition } from "./step-schema";

// What a Save sends and what it must satisfy (spec 0022 AC-9). Normalized
// first (trim, empty to null, lowercase email), then checked, so the diff and
// the stored values compare the same shapes. Errors are keyed by dotted path:
// `abortEmail`, `mode`, `steps.2.featureName`, `steps.2.definition.parts.0.…`.
// Safe on both sides.
const abortEmail = z
  .string()
  .nullish()
  .transform(normalizeEmail)
  .pipe(
    z
      .email("Enter a valid email address.")
      .max(254, "An email address is 254 characters at most.")
      .nullable(),
  );

const featureName = z
  .string()
  .transform(trimmed)
  .pipe(
    z
      .string()
      .min(1, "Enter a name.")
      .max(60, "A name is 60 characters at most."),
  );

const note = z
  .string()
  .nullish()
  .transform(nullIfEmpty)
  .pipe(z.string().max(300, "A note is 300 characters at most.").nullable());

const draftStep = z.strictObject({
  // An existing row, kept. Absent for a new row.
  id: z.uuid().optional(),
  // A new row added from the starting list.
  seedKey: z.string().max(80).optional(),
  featureName,
  enabled: z.boolean(),
  note,
  definition: StepDefinition,
});
export type DraftStep = z.output<typeof draftStep>;

// The fields the row dialog edits (spec 0022 AC-23), checked with the same
// rules Save uses so the dialog and Save never disagree.
export const StepFields = draftStep.pick({
  featureName: true,
  enabled: true,
  note: true,
  definition: true,
});
export type StepFields = z.output<typeof StepFields>;

// A Server Action body is 1 MB by default (next.config.ts keeps that), and the
// per step cap alone would allow about 2 MB. This keeps the whole list under it
// with room for the other fields, and refuses with a field error instead of a
// generic failure.
export const MAX_LIST_BYTES = 600_000;

export const SaveRequest = z
  .strictObject({
    expectedVersion: z.number().int().min(1),
    abortEmail,
    mode: PortalResetMode,
    steps: z
      .array(draftStep)
      .min(1, "Keep at least one step.")
      .max(MAX_STEPS, `A list holds ${MAX_STEPS} steps at most.`),
  })
  .superRefine((request, ctx) => {
    const bytes = new TextEncoder().encode(
      JSON.stringify(request.steps.map((step) => step.definition)),
    ).length;
    if (bytes > MAX_LIST_BYTES) {
      ctx.addIssue({
        code: "custom",
        message: "The whole list is too large to save. Shorten some steps.",
        path: ["steps"],
      });
    }
    unsafeDeleteOrder(request.steps).forEach((i) => {
      ctx.addIssue({
        code: "custom",
        message: ORDER_MESSAGE,
        path: ["steps", i, "featureName"],
      });
    });
    request.steps.forEach((step, i) => {
      const first = request.steps.findIndex(
        (s) => nameKey(s.featureName) === nameKey(step.featureName),
      );
      if (first !== i) {
        ctx.addIssue({
          code: "custom",
          message: "Another step already has this name.",
          path: ["steps", i, "featureName"],
        });
      }
    });
  });
export type SaveRequest = z.output<typeof SaveRequest>;
