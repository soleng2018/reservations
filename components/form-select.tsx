"use client";

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
// in a plain <form>. Controlled when `value` is given.
export function FormSelect({
  id,
  name,
  options,
  placeholder,
  value,
  defaultValue,
  onValueChange,
  invalid,
  describedBy,
}: {
  readonly id: string;
  readonly name: string;
  readonly options: readonly SelectOption[];
  readonly placeholder: string;
  readonly value?: string | null;
  readonly defaultValue?: string;
  readonly onValueChange?: (value: string) => void;
  readonly invalid?: boolean;
  readonly describedBy?: string;
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
      <SelectTrigger
        id={id}
        className="w-full"
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
      >
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
