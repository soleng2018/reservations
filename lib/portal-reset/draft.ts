import type { PortalResetMode } from "@/lib/db-enums";
import { fieldErrors, type FieldErrors } from "@/lib/form-errors";
import { err, ok, type Result } from "@/lib/result";
import { nameKey, stableStringify } from "./normalize";
import { StepFields } from "./save-input";
import { StepDefinition } from "./step-schema";
import { rowView, type ResetRowView } from "./view";

// The draft of the Nile Portal Reset page while an admin edits (spec 0022
// AC-5, AC-6): plain data and pure functions, so the page keeps one value in
// `useState` and none of this needs a browser to test. Nothing here is
// stored until Save. Safe on both sides.

// One step of the saved list as the page hands it to the editor.
export type EditorStep = {
  readonly id: string;
  readonly featureName: string;
  readonly enabled: boolean;
  readonly note: string | null;
  // The parsed definition, or the stored JSON when it no longer parses (the
  // admin can then fix it in the row dialog).
  readonly definition: unknown;
};

export type DraftEntry = {
  // Identifies the row on screen; never sent to the server.
  readonly clientKey: string;
  // The stored row this came from, or null for a row added in this draft.
  readonly id: string | null;
  readonly featureName: string;
  readonly enabled: boolean;
  readonly note: string | null;
  readonly definition: unknown;
};

export type Draft = {
  // The text of the field, so an empty one stays empty.
  readonly abortEmail: string;
  readonly mode: PortalResetMode;
  readonly steps: readonly DraftEntry[];
};

export type Saved = {
  readonly abortEmail: string | null;
  readonly mode: PortalResetMode;
  readonly steps: readonly EditorStep[];
};

export const startDraft = (saved: Saved): Draft => ({
  abortEmail: saved.abortEmail ?? "",
  mode: saved.mode,
  steps: saved.steps.map((s) => ({ ...s, clientKey: s.id })),
});

export const appendEntry = (draft: Draft, entry: DraftEntry): Draft => ({
  ...draft,
  steps: [...draft.steps, entry],
});

export const replaceEntry = (draft: Draft, entry: DraftEntry): Draft => ({
  ...draft,
  steps: draft.steps.map((s) => (s.clientKey === entry.clientKey ? entry : s)),
});

export const removeEntry = (draft: Draft, clientKey: string): Draft => ({
  ...draft,
  steps: draft.steps.filter((s) => s.clientKey !== clientKey),
});

// What Save receives, minus the version the page adds. Order numbers are not
// sent: the server sets them from the array index.
export const saveInput = (draft: Draft) => ({
  abortEmail: draft.abortEmail,
  mode: draft.mode,
  steps: draft.steps.map((s) => ({
    ...(s.id === null ? {} : { id: s.id }),
    featureName: s.featureName,
    enabled: s.enabled,
    note: s.note,
    definition: s.definition,
  })),
});

// Whether the draft differs from where it started, by what a Save would send.
export const isDirty = (start: Draft, draft: Draft): boolean =>
  stableStringify(saveInput(start)) !== stableStringify(saveInput(draft));

// A draft row as the read only table shows it (number, description, guards).
export const entryView = (entry: DraftEntry, index: number): ResetRowView => {
  const parsed = StepDefinition.safeParse(entry.definition);
  return rowView(
    {
      id: entry.clientKey,
      position: index + 1,
      featureName: entry.featureName,
      enabled: entry.enabled,
      note: entry.note,
    },
    parsed.success ? parsed.data : null,
  );
};

// The text the row dialog edits: the whole definition (the parts and the
// pages the discovery pass visits) as formatted JSON.
export const definitionText = (definition: unknown): string =>
  JSON.stringify(definition, null, 2) ?? "{}";

// The text checked against the step language (spec 0022 AC-23). Errors are
// keyed by the same dotted paths Save uses, relative to the definition
// (`parts.0.delete.path`).
export function parseDefinitionText(
  text: string,
): Result<StepDefinition, FieldErrors> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return err({ "": "This is not valid JSON." });
  }
  const parsed = StepDefinition.safeParse(json);
  return parsed.success ? ok(parsed.data) : err(fieldErrors(parsed.error));
}

export type EntryFields = {
  readonly featureName: string;
  readonly enabled: boolean;
  readonly note: string | null;
  readonly definition: StepDefinition;
};

// A row dialog's input, checked with the rules Save uses plus the repeated
// name check against the other rows. Errors are keyed `featureName`, `note`,
// `definition`, `definition.parts.0.…`.
export function checkEntry(
  input: {
    readonly featureName: string;
    readonly enabled: boolean;
    readonly note: string;
    readonly definitionText: string;
  },
  others: readonly DraftEntry[],
): Result<EntryFields, FieldErrors> {
  const definition = parseDefinitionText(input.definitionText);
  const named = {
    featureName: input.featureName,
    enabled: input.enabled,
    note: input.note,
  };
  const parsed = definition.ok
    ? StepFields.safeParse({ ...named, definition: definition.value })
    : StepFields.omit({ definition: true }).safeParse(named);
  const errors: Record<string, string> = {
    ...(parsed.success ? {} : fieldErrors(parsed.error)),
    ...(definition.ok
      ? {}
      : Object.fromEntries(
          Object.entries(definition.error).map(([path, message]) => [
            path === "" ? "definition" : `definition.${path}`,
            message,
          ]),
        )),
  };
  if (
    !("featureName" in errors) &&
    others.some((o) => nameKey(o.featureName) === nameKey(input.featureName))
  ) {
    errors.featureName = "Another step already has this name.";
  }
  if (Object.keys(errors).length > 0 || !definition.ok || !parsed.success) {
    return err(errors);
  }
  return ok({ ...parsed.data, definition: definition.value });
}
