import {
  bookingPhase,
  type BookingPhase,
  type PhaseInput,
} from "./booking-phase";

// The learner's "Manage your reservation" list (spec 0011 AC-1, AC-6). Pure:
// the clock and the zone are always passed in.

// "Ada" from "  Ada  Lovelace ": the first word of the trimmed name.
export const firstName = (name: string): string =>
  name.trim().split(/\s+/)[0] ?? "";

// "America/New York": the "Times in" note under the list. No offset, since
// one offset would be wrong for cards on the other side of a DST change.
export const zoneName = (zone: string): string => zone.replaceAll("_", " ");

const PHASE_RANK: Readonly<Record<BookingPhase, number>> = {
  Current: 0,
  Upcoming: 1,
  Past: 2,
  Pending: 3,
  Cancelled: 4,
};

// Current first, then Upcoming by start ascending, then Past by start
// descending; equal starts fall back to the id so the order is stable.
export function sortCards<T extends PhaseInput & { readonly id: string }>(
  rows: readonly T[],
  now: Date,
): readonly (T & { readonly phase: BookingPhase })[] {
  return rows
    .map((r) => ({ ...r, phase: bookingPhase(r, now) }))
    .toSorted((a, b) => {
      const rank = PHASE_RANK[a.phase] - PHASE_RANK[b.phase];
      if (rank !== 0) return rank;
      const byStart = a.startsAt.getTime() - b.startsAt.getTime();
      if (byStart !== 0) return a.phase === "Past" ? -byStart : byStart;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
}

export type CardActions = {
  readonly reschedule: boolean;
  readonly cancel: boolean;
  // "This lab type can't be rescheduled right now."
  readonly cannotReschedule: boolean;
  // "View lab access" (spec 0012 AC-6), between Reschedule and Cancel.
  readonly viewAccess: boolean;
};

const NONE: CardActions = {
  reschedule: false,
  cancel: false,
  cannotReschedule: false,
  viewAccess: false,
};

// Upcoming and Current cards can be cancelled, and rescheduled when the type
// still has a bookable testbed. Current and Past cards link to their lab
// access; Upcoming ones do not (the mock).
export function cardActions(
  phase: BookingPhase,
  reschedulable: boolean,
): CardActions {
  switch (phase) {
    case "Upcoming":
    case "Current":
      return {
        reschedule: reschedulable,
        cancel: true,
        cannotReschedule: !reschedulable,
        viewAccess: phase === "Current",
      };
    case "Past":
      return { ...NONE, viewAccess: true };
    case "Pending":
    case "Cancelled":
      return NONE;
    default: {
      const never: never = phase;
      throw new Error(`unknown booking phase: ${String(never)}`);
    }
  }
}

// The cancel dialog's extra line for a Current booking (spec 0012 AC-13,
// AC-14), or none. Only the learner is asked to close their tabs, since the
// end of access doesn't close an open VM tab and an admin can't close it.
export function cancelAccessLine(
  who: "learner" | "admin",
  current: boolean,
): string | null {
  if (!current) return null;
  switch (who) {
    case "learner":
      return " Your lab access ends within a minute. Close any open lab tabs.";
    case "admin":
      return " The learner's lab access ends within a minute.";
    default: {
      const never: never = who;
      throw new Error(`unknown cancel dialog: ${String(never)}`);
    }
  }
}

// The kept testbed first, the rest in their given order. A preferred id that
// is not among the candidates changes nothing.
export function preferFirst<T extends { readonly id: string }>(
  candidates: readonly T[],
  preferId: string,
): readonly T[] {
  const preferred = candidates.find((c) => c.id === preferId);
  return preferred
    ? [preferred, ...candidates.filter((c) => c.id !== preferId)]
    : candidates;
}
