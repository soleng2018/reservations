"use client";

import { Field } from "@/components/field";
import { FormSelect } from "@/components/form-select";
import { Input } from "@/components/ui/input";

const UNITS = [
  { value: "hours", label: "Hours" },
  { value: "days", label: "Days" },
] as const;

// Spec 0004 AC-1's inputs, inside the form modal. Errors come from the
// FormDialog around them.
export function TestbedTypeFields() {
  return (
    <>
      <Field path="name" label="Name">
        <Input name="name" required maxLength={200} placeholder="e.g. Basic" />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field path="durationValue" label="Duration">
          <Input
            name="durationValue"
            type="number"
            min={1}
            step={1}
            defaultValue={1}
            required
          />
        </Field>
        <Field path="durationUnit" label="Unit">
          <FormSelect
            name="durationUnit"
            options={UNITS}
            placeholder="Choose a unit"
            defaultValue="hours"
          />
        </Field>
      </div>
    </>
  );
}
