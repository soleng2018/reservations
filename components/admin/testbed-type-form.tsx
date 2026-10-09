"use client";

import { startTransition, useActionState, type FormEvent } from "react";
import {
  createTestbedTypeAction,
  type AdminFormState,
} from "@/app/admin/actions";
import { errorId, FormField } from "@/components/form-field";
import { FormSelect } from "@/components/form-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useFormKey } from "./use-form-key";

const UNITS = [
  { value: "hours", label: "Hours" },
  { value: "days", label: "Days" },
] as const;

const IDLE: AdminFormState = { kind: "idle" };

// AC-1: create a testbed type. Submitted from onSubmit, not the form action,
// so React does not clear the fields when the server returns an error.
export function TestbedTypeForm() {
  const [state, action, pending] = useActionState(
    createTestbedTypeAction,
    IDLE,
  );
  const key = useFormKey(state);
  const fields = state.kind === "error" ? state.fields : {};
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    startTransition(() => action(data));
  };

  return (
    <form key={key} onSubmit={onSubmit} className="flex flex-col gap-4">
      <FormField id="type-name" label="Name" error={fields.name}>
        <Input
          id="type-name"
          name="name"
          required
          maxLength={200}
          aria-invalid={Boolean(fields.name) || undefined}
          aria-describedby={fields.name ? errorId("type-name") : undefined}
        />
      </FormField>
      <div className="grid grid-cols-2 gap-3">
        <FormField
          id="type-duration"
          label="Duration"
          error={fields.durationValue}
        >
          <Input
            id="type-duration"
            name="durationValue"
            type="number"
            min={1}
            step={1}
            defaultValue={1}
            required
            aria-invalid={Boolean(fields.durationValue) || undefined}
            aria-describedby={
              fields.durationValue ? errorId("type-duration") : undefined
            }
          />
        </FormField>
        <FormField id="type-unit" label="Unit" error={fields.durationUnit}>
          <FormSelect
            id="type-unit"
            name="durationUnit"
            options={UNITS}
            placeholder="Choose a unit"
            defaultValue="hours"
            invalid={Boolean(fields.durationUnit)}
            describedBy={fields.durationUnit ? errorId("type-unit") : undefined}
          />
        </FormField>
      </div>
      <FormStatus state={state} />
      <Button type="submit" disabled={pending} className="self-start">
        {pending ? "Saving…" : "Create type"}
      </Button>
    </form>
  );
}

export function FormStatus({ state }: { readonly state: AdminFormState }) {
  const message =
    state.kind === "saved"
      ? state.message
      : state.kind === "error"
        ? state.message
        : undefined;
  return (
    <p
      role="status"
      aria-live="polite"
      className={
        state.kind === "error"
          ? "text-sm text-destructive"
          : "text-sm text-muted-foreground"
      }
    >
      {message}
    </p>
  );
}
