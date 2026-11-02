import { z } from "zod";
import { hasFullName } from "./nile-login";

// Spec 0025 AC-1: the one schema every form and action uses to check a
// learner's name, so the rule exists once (in `hasFullName`).
export const fullName = (message: string) =>
  z
    .string({ error: message })
    .trim()
    .max(200, message)
    .refine(hasFullName, message);
