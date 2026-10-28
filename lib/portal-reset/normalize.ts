import type { ZodError } from "zod";
import { type Result, err, ok } from "@/lib/result";
import { StepDefinition } from "./step-schema";

// Normalization (spec 0022): applied before validation, comparison, and
// storage, so the "no change" rule and the version bump compare the same
// shapes. Pure. Safe on both sides.
export const trimmed = (text: string): string => text.trim();

// An empty note or email becomes null.
export const nullIfEmpty = (text: string | null | undefined): string | null => {
  const value = (text ?? "").trim();
  return value === "" ? null : value;
};

export const normalizeEmail = (
  text: string | null | undefined,
): string | null => nullIfEmpty(text)?.toLowerCase() ?? null;

// Feature names compare ignoring case but are stored as typed (trimmed).
export const nameKey = (featureName: string): string =>
  trimmed(featureName).toLowerCase();

// JSON with every object's keys sorted and undefined dropped, so two
// definitions that differ only by key order or spaces compare equal.
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

// A definition in canonical form: parsed against the step language, keys in
// schema order, defaults not filled in. A definition that does not parse is
// returned as the Zod error, for the caller to key by path.
export function canonicalDefinition(
  raw: unknown,
): Result<StepDefinition, ZodError> {
  const parsed = StepDefinition.safeParse(raw);
  return parsed.success ? ok(parsed.data) : err(parsed.error);
}
