import type { ReactNode } from "react";
import { Label } from "@/components/ui/label";

export const errorId = (id: string) => `${id}-error`;

// A label, its control, and the field's error, linked for screen readers
// (the control sets aria-describedby={errorId(id)} when `error` is set).
export function FormField({
  id,
  label,
  error,
  children,
}: {
  readonly id: string;
  readonly label: string;
  readonly error?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? (
        <p id={errorId(id)} className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
