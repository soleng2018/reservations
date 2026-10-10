"use client";

import { useState } from "react";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { Field } from "@/components/field";
import { FormSelect, type SelectOption } from "@/components/form-select";
import { Button } from "@/components/ui/button";
import { FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

const KINDS = [
  { value: "wired", label: "Wired" },
  { value: "wireless", label: "Wireless" },
] as const;

// Spec 0004 AC-2's inputs, inside the form modal. Saving also creates the
// testbed's Authentik access group, so a failure there arrives as the
// modal's form level message.
export function TestbedFields({
  types,
}: {
  readonly types: readonly SelectOption[];
}) {
  // Stable ids for the client rows, so removing one keeps the others' input.
  // Plain numbers: random UUIDs are missing on plain http (dev), see
  // tests/client-secure-context.test.ts.
  const [rows, setRows] = useState<readonly number[]>([]);

  return (
    <>
      <Field path="name" label="Name">
        <Input name="name" required placeholder="e.g. Nile Workshop 1" />
      </Field>
      <Field
        path="testbedTypeId"
        label="Type"
        description={
          types.length === 0 ? "Add a testbed type first." : undefined
        }
      >
        <FormSelect
          name="testbedTypeId"
          options={types}
          placeholder="Choose a type"
        />
      </Field>
      <Field path="portalUrl" label="Nile Portal URL">
        <Input name="portalUrl" type="url" required placeholder="https://…" />
      </Field>
      <Field path="lmsUrl" label="LMS URL">
        <Input name="lmsUrl" type="url" required placeholder="https://…" />
      </Field>

      <FieldSet className="gap-2.5">
        <div className="flex items-center justify-between gap-3">
          <FieldLegend variant="label" className="mb-0 text-[0.8125rem]">
            Clients
          </FieldLegend>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="rounded-sm border-dashed text-nile-blue"
            // Rows stay in ascending order, so last + 1 is unused.
            onClick={() => setRows([...rows, (rows.at(-1) ?? -1) + 1])}
          >
            <PlusIcon data-icon="inline-start" aria-hidden="true" />
            Add client
          </Button>
        </div>
        {rows.length === 0 ? (
          <p className="text-pill text-fg3">
            No clients yet. Add wired or wireless clients for this testbed.
          </p>
        ) : null}
        {rows.map((row, i) => (
          <div
            key={row}
            className="grid grid-cols-1 gap-3 rounded-md border p-3 sm:grid-cols-[7.5rem_1fr] sm:items-start"
          >
            <Field path={`clients.${i}.kind`} label="Kind">
              <FormSelect
                name="clientKind"
                options={KINDS}
                placeholder="Kind"
                defaultValue="wired"
              />
            </Field>
            <Field path={`clients.${i}.name`} label="Name">
              <Input name="clientName" required />
            </Field>
            <Field
              path={`clients.${i}.url`}
              label="URL"
              className="sm:col-span-2"
            >
              <Input name="clientUrl" type="url" required />
            </Field>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="justify-self-end text-destructive hover:bg-crimson-100 hover:text-destructive sm:col-span-2"
              aria-label={`Remove client ${i + 1}`}
              onClick={() => setRows(rows.filter((r) => r !== row))}
            >
              <Trash2Icon data-icon="inline-start" aria-hidden="true" />
              Remove
            </Button>
          </div>
        ))}
      </FieldSet>
    </>
  );
}
