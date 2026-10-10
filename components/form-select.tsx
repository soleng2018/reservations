"use client";

import type { FieldControlProps } from "@/components/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type SelectOption = { readonly value: string; readonly label: string };

// A shadcn (Base UI) select that submits its value under `name`, so it works
// in a plain <form>. Controlled when `value` is given. Inside a Field, the
// field's id and aria props land on the trigger.
export function FormSelect({
  name,
  options,
  placeholder,
  value,
  defaultValue,
  onValueChange,
  ...control
}: FieldControlProps & {
  readonly name: string;
  readonly options: readonly SelectOption[];
  readonly placeholder: string;
  readonly value?: string | null;
  readonly defaultValue?: string;
  readonly onValueChange?: (value: string) => void;
}) {
  const items = [{ value: null, label: placeholder }, ...options];
  return (
    <Select
      name={name}
      items={items}
      {...(value !== undefined
        ? { value }
        : { defaultValue: defaultValue ?? null })}
      onValueChange={(v) => {
        if (typeof v === "string") onValueChange?.(v);
      }}
    >
      <SelectTrigger className="w-full" {...control}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
