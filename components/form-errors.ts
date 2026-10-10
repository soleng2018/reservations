"use client";

import { createContext, useContext } from "react";
import type { FieldErrors } from "@/lib/form-errors";

// The errors of the form a field sits in, keyed by dotted path. FormDialog
// provides them; outside one, there are none.
export type FormErrors = {
  readonly fields: FieldErrors;
  readonly message?: string;
};

export const FormErrorsContext = createContext<FormErrors>({ fields: {} });

export const useFormErrors = (): FormErrors => useContext(FormErrorsContext);
