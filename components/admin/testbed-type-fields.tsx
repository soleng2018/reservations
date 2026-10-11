"use client";

import { useState } from "react";
import { Field } from "@/components/field";
import { FormSelect } from "@/components/form-select";
import { Input } from "@/components/ui/input";

const UNITS = [
  { value: "hours", label: "Hours" },
  { value: "days", label: "Days" },
] as const;

export type TestbedTypeDefaults = {
  readonly name: string;
  readonly durationValue: number;
  readonly durationUnit: "hours" | "days";
};

const NEW_TYPE: TestbedTypeDefaults = {
  name: "",
  durationValue: 1,
  durationUnit: "hours",
};

// Spec 0004 AC-1's inputs, inside the form modal: empty to add, the row's
// values to edit (feature 7). Errors come from the FormDialog around them.
// The defaults are read once on open: a save refreshes the row while the
// dialog is still closing, and an uncontrolled input must not see new ones.
export function TestbedTypeFields({
  defaults: initial = NEW_TYPE,
}: {
  readonly defaults?: TestbedTypeDefaults;
}) {
  const [defaults] = useState(initial);
  return (
    <>
      <Field path="name" label="Name">
        <Input
          name="name"
          required
          maxLength={200}
          placeholder="e.g. Basic"
          defaultValue={defaults.name}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field path="durationValue" label="Duration">
          <Input
            name="durationValue"
            type="number"
            min={1}
            step={1}
            defaultValue={defaults.durationValue}
            required
          />
        </Field>
        <Field path="durationUnit" label="Unit">
          <FormSelect
            name="durationUnit"
            options={UNITS}
            placeholder="Choose a unit"
            defaultValue={defaults.durationUnit}
          />
        </Field>
      </div>
    </>
  );
}
