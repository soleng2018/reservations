"use client";

import { useState } from "react";
import type { AdminFormState } from "@/app/admin/actions";

// A key that changes only after a successful save, so the form remounts
// empty then, and keeps what the admin typed after an error. Uses React's
// "adjust state while rendering" pattern instead of an effect.
export function useFormKey(state: AdminFormState): number {
  const [seen, setSeen] = useState(state);
  const [key, setKey] = useState(0);
  if (state !== seen) {
    setSeen(state);
    if (state.kind === "saved") setKey((k) => k + 1);
  }
  return key;
}
