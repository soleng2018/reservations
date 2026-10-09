"use client";

import {
  startTransition,
  useActionState,
  useId,
  useState,
  type FormEvent,
} from "react";
import { createTestbedAction, type AdminFormState } from "@/app/admin/actions";
import { errorId, FormField } from "@/components/form-field";
import { FormSelect, type SelectOption } from "@/components/form-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormStatus } from "./testbed-type-form";
import { useFormKey } from "./use-form-key";

const KINDS = [
  { value: "wired", label: "Wired" },
  { value: "wireless", label: "Wireless" },
] as const;

const IDLE: AdminFormState = { kind: "idle" };

// AC-2: create a testbed and its clients. Saving also creates its Authentik
// access group, so a failure there shows a form level message.
export function TestbedForm({
  types,
}: {
  readonly types: readonly SelectOption[];
}) {
  const [state, action, pending] = useActionState(createTestbedAction, IDLE);
  const key = useFormKey(state);
  return (
    <TestbedFields
      key={key}
      types={types}
      state={state}
      pending={pending}
      submit={(data) => startTransition(() => action(data))}
    />
  );
}

function TestbedFields({
  types,
  state,
  pending,
  submit,
}: {
  readonly types: readonly SelectOption[];
  readonly state: AdminFormState;
  readonly pending: boolean;
  readonly submit: (data: FormData) => void;
}) {
  // Stable ids for the client rows, so removing one keeps the others' input.
  // Plain numbers: random UUIDs are missing on plain http (dev), see
  // tests/client-secure-context.test.ts.
  const [rows, setRows] = useState<readonly number[]>([]);
  const prefix = useId();
  const fields = state.kind === "error" ? state.fields : {};
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    submit(new FormData(e.currentTarget));
  };
  const text = (id: string, name: string, label: string, type = "text") => (
    <FormField id={id} label={label} error={fields[name]}>
      <Input
        id={id}
        name={name}
        type={type}
        required
        aria-invalid={Boolean(fields[name]) || undefined}
        aria-describedby={fields[name] ? errorId(id) : undefined}
      />
    </FormField>
  );

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      {text("testbed-name", "name", "Name")}
      <FormField id="testbed-type" label="Type" error={fields.testbedTypeId}>
        <FormSelect
          id="testbed-type"
          name="testbedTypeId"
          options={types}
          placeholder="Choose a type"
          invalid={Boolean(fields.testbedTypeId)}
          describedBy={
            fields.testbedTypeId ? errorId("testbed-type") : undefined
          }
        />
      </FormField>
      {text("testbed-portal", "portalUrl", "Nile Portal URL", "url")}
      {text("testbed-lms", "lmsUrl", "LMS URL", "url")}

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-2 text-sm font-medium">Clients</legend>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No clients yet.</p>
        ) : null}
        {rows.map((row, i) => {
          const rowId = `${prefix}client-${row}`;
          const err = (f: string) => fields[`clients.${i}.${f}`];
          return (
            <div
              key={row}
              className="grid grid-cols-1 gap-3 rounded-lg border p-3 sm:grid-cols-[8rem_1fr_1fr_auto] sm:items-end"
            >
              <FormField id={`${rowId}-kind`} label="Kind" error={err("kind")}>
                <FormSelect
                  id={`${rowId}-kind`}
                  name="clientKind"
                  options={KINDS}
                  placeholder="Kind"
                  defaultValue="wired"
                />
              </FormField>
              <FormField id={`${rowId}-name`} label="Name" error={err("name")}>
                <Input
                  id={`${rowId}-name`}
                  name="clientName"
                  required
                  aria-invalid={Boolean(err("name")) || undefined}
                />
              </FormField>
              <FormField id={`${rowId}-url`} label="URL" error={err("url")}>
                <Input
                  id={`${rowId}-url`}
                  name="clientUrl"
                  type="url"
                  required
                  aria-invalid={Boolean(err("url")) || undefined}
                />
              </FormField>
              <Button
                type="button"
                variant="outline"
                onClick={() => setRows(rows.filter((r) => r !== row))}
              >
                Remove
              </Button>
            </div>
          );
        })}
        <Button
          type="button"
          variant="outline"
          className="self-start"
          // Rows stay in ascending order, so last + 1 is unused.
          onClick={() => setRows([...rows, (rows.at(-1) ?? -1) + 1])}
        >
          Add client
        </Button>
      </fieldset>

      <FormStatus state={state} />
      <Button
        type="submit"
        disabled={pending || types.length === 0}
        className="self-start"
      >
        {pending ? "Saving…" : "Create testbed"}
      </Button>
    </form>
  );
}
