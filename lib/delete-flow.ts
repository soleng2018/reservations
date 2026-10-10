import type { Result } from "./result";

// The delete flow contract (spec 0005 *Delete flow contract*), shared by
// features 7 to 10. Safe on both sides.

export type DeleteKind = "api_key" | "testbed_type" | "testbed";

// Something that stops a delete, labelled for the admin (a testbed name, or
// a learner's name for a reservation).
export type Blocker = { readonly id: string; readonly label: string };

// Run on click. ok with [] means "safe to confirm".
export type DeleteCheck = (
  id: string,
) => Promise<Result<readonly Blocker[], "unavailable">>;

export type DeleteRemoveError =
  | { readonly kind: "blocked"; readonly blockers: readonly Blocker[] }
  | { readonly kind: "failed"; readonly message: string };

// Locks, checks again, and deletes, in one transaction (spec 0002 AC-14).
export type DeleteRemove = (
  id: string,
) => Promise<Result<void, DeleteRemoveError>>;

type BlockedCopy = {
  readonly title: string;
  readonly message: (label: string) => string;
};

// The blocked dialog's copy per kind, from the mock.
export const BLOCKED_COPY: Readonly<Record<DeleteKind, BlockedCopy>> = {
  api_key: {
    title: "API key in use",
    message: (label) =>
      `"${label}" is assigned to the testbeds below. Remove it from them first.`,
  },
  testbed_type: {
    title: "Testbed type in use",
    message: (label) =>
      `"${label}" is assigned to the testbeds below. Reassign or delete them first.`,
  },
  testbed: {
    title: "Testbed has active reservations",
    message: (label) =>
      `"${label}" has upcoming or current reservations below. Resolve them first.`,
  },
};

export const confirmMessage = (label: string): string =>
  `Delete "${label}"? This can't be undone.`;

export const DELETE_TOASTS = {
  deleted: "Deleted.",
  unavailable: "Couldn't check whether this can be deleted. Try again.",
  generic: "Something went wrong. Try again.",
} as const;
