"use client";

import { cloneElement, useId, type ReactElement, type ReactNode } from "react";
import { useFormErrors } from "@/components/form-errors";
import {
  FieldDescription,
  FieldError,
  FieldLabel,
  Field as FieldRoot,
} from "@/components/ui/field";

// The props Field gives its one control.
export type FieldControlProps = {
  readonly id?: string;
  readonly "aria-invalid"?: boolean;
  readonly "aria-describedby"?: string;
  readonly "data-field"?: string;
};

// A label, its control, an optional description, and the field's error,
// linked for screen readers. `path` is the dotted error key (`name`,
// `clients.0.url`); the error comes from `error`, else from the enclosing
// FormDialog. The control is marked aria-invalid and data-field=<path>, so
// FormDialog can focus the first invalid one.
export function Field({
  path,
  label,
  description,
  error,
  className,
  children,
}: {
  readonly path: string;
  readonly label: ReactNode;
  readonly description?: ReactNode;
  readonly error?: string;
  readonly className?: string;
  readonly children: ReactElement<FieldControlProps>;
}) {
  const id = useId();
  const { fields } = useFormErrors();
  const message = error ?? fields[path];
  const descriptionId = `${id}-description`;
  const errorId = `${id}-error`;
  const describedBy =
    [description ? descriptionId : null, message ? errorId : null]
      .filter((x) => x !== null)
      .join(" ") || undefined;

  return (
    <FieldRoot data-invalid={message ? true : undefined} className={className}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {cloneElement(children, {
        id,
        "aria-invalid": message ? true : undefined,
        "aria-describedby": describedBy,
        "data-field": path,
      })}
      {description ? (
        <FieldDescription id={descriptionId}>{description}</FieldDescription>
      ) : null}
      {message ? (
        // Not role=alert: focus moves to the first invalid control, which
        // reads this through aria-describedby.
        <FieldError id={errorId} role={undefined}>
          {message}
        </FieldError>
      ) : null}
    </FieldRoot>
  );
}
