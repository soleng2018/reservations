"use client";

import { useEffect, useState, type ReactElement } from "react";
import {
  FormDialog,
  type AdminFormAction,
} from "@/components/admin/form-dialog";
import { Field } from "@/components/field";
import { useFormErrors } from "@/components/form-errors";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  checkEntry,
  definitionText,
  parseDefinitionText,
  type DraftEntry,
  type EntryFields,
} from "@/lib/portal-reset/draft";
import { describeStep } from "@/lib/portal-reset/describe";
import type { FieldErrors } from "@/lib/form-errors";
import type { Result } from "@/lib/result";
import type { StepDefinition } from "@/lib/portal-reset/step-schema";

// What a new row starts with: a step with no parts, which the dialog will not
// apply until the admin writes some.
const NEW_STEP_TEXT = definitionText({ parts: [] });

const textOf = (form: FormData, key: string): string => {
  const value = form.get(key);
  return typeof value === "string" ? value : "";
};

// The Add and Edit dialog of one row (spec 0022 AC-23). It edits a copy in
// the browser: Apply hands the checked row to the draft, and nothing is
// stored until the page's Save. The definition is formatted JSON, checked on
// every change against the same schema Save uses; invalid text cannot be
// applied, and nothing here ever contacts a portal.
export function PortalResetRowDialog({
  trigger,
  entry,
  others,
  onApply,
}: {
  readonly trigger: ReactElement;
  // The row being changed, or null to add one.
  readonly entry: DraftEntry | null;
  // Every other row of the draft, for the repeated name check.
  readonly others: readonly DraftEntry[];
  readonly onApply: (fields: EntryFields) => void;
}) {
  const action: AdminFormAction = async (_prev, form) => {
    const checked = checkEntry(
      {
        featureName: textOf(form, "featureName"),
        enabled: form.get("enabled") !== null,
        note: textOf(form, "note"),
        definitionText: textOf(form, "definition"),
      },
      others,
    );
    if (!checked.ok) return { kind: "error", fields: checked.error };
    onApply(checked.value);
    return {
      kind: "saved",
      message:
        entry === null
          ? "Step added to the draft. Save the page to keep it."
          : "Step changed in the draft. Save the page to keep it.",
    };
  };

  return (
    <FormDialog
      trigger={trigger}
      title={entry === null ? "Add a step" : "Edit step"}
      action={action}
      submitLabel={entry === null ? "Add to draft" : "Apply to draft"}
    >
      <RowFields entry={entry} />
    </FormDialog>
  );
}

// The fields read their defaults once, when the dialog opens (the repo rule
// for edit dialogs): the dialog's body mounts on open.
function RowFields({ entry }: { readonly entry: DraftEntry | null }) {
  const initial =
    entry === null ? NEW_STEP_TEXT : definitionText(entry.definition);
  const [text, setText] = useState(initial);
  const [checked, setChecked] = useState<{
    readonly text: string;
    readonly result: Result<StepDefinition, FieldErrors>;
  } | null>(null);
  const submitted = useFormErrors().fields;

  // Validated a moment after the last keystroke, and only once the text has
  // been changed: a fresh dialog does not open full of errors.
  useEffect(() => {
    if (text === initial) return;
    const timer = setTimeout(
      () => setChecked({ text, result: parseDefinitionText(text) }),
      250,
    );
    return () => clearTimeout(timer);
  }, [text, initial]);

  const live =
    checked !== null && checked.text === text ? checked.result : null;
  const problems =
    live !== null
      ? live.ok
        ? []
        : Object.entries(live.error)
      : Object.entries(submitted)
          .filter(
            ([path]) => path === "definition" || path.startsWith("definition."),
          )
          .map(([path, message]): [string, string] => [
            path.replace(/^definition\.?/, ""),
            message,
          ]);
  const sentences = live !== null && live.ok ? describeStep(live.value) : [];

  return (
    <>
      <Field path="featureName" label="Name">
        <Input
          name="featureName"
          defaultValue={entry?.featureName ?? ""}
          maxLength={60}
          autoComplete="off"
        />
      </Field>
      <Field
        path="note"
        label="Note"
        description="Optional. Shown under the name."
      >
        <Input
          name="note"
          defaultValue={entry?.note ?? ""}
          maxLength={300}
          autoComplete="off"
        />
      </Field>
      <Field
        path="enabled"
        label="Enabled"
        description="A disabled step is kept in the list, and a reset skips it."
      >
        <Switch name="enabled" defaultChecked={entry?.enabled ?? true} />
      </Field>
      <Field
        path="definition"
        label="Steps, as JSON"
        description="The parts of this step, run in order. Paths must start with /api/."
        error={
          problems.length > 0
            ? `${problems.length === 1 ? "1 problem" : `${problems.length} problems`} in the JSON.`
            : undefined
        }
      >
        <Textarea
          name="definition"
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          className="max-h-80 min-h-48 font-mono text-xs"
        />
      </Field>
      {problems.length > 0 ? (
        <ul
          aria-label="Problems in the JSON"
          className="flex flex-col gap-1.5 text-xs text-danger-strong"
        >
          {problems.map(([path, message]) => (
            <li key={path} className="break-words">
              {path === "" ? null : (
                <code className="font-mono font-semibold">{path}</code>
              )}
              {path === "" ? null : ": "}
              {message}
            </li>
          ))}
        </ul>
      ) : null}
      {sentences.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-th font-semibold tracking-wide text-fg3 uppercase">
            What this does
          </p>
          <ul className="flex flex-col gap-1.5">
            {sentences.map((line, i) => (
              <li key={i} className="text-sub break-words text-fg2">
                {line}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}
