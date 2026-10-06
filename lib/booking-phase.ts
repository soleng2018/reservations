import type { BookingStatus } from "./db-enums";

// What a booking looks like to people. The only place this mapping lives
// (spec 0002, AC-11). `Pending` is admin only; learners never see provisioning.
export type BookingPhase =
  "Upcoming" | "Current" | "Past" | "Cancelled" | "Pending";

export type PhaseInput = {
  readonly status: BookingStatus;
  readonly startsAt: Date;
  readonly endsAt: Date;
};

export function bookingPhase(b: PhaseInput, now: Date): BookingPhase {
  switch (b.status) {
    case "cancelled":
      return "Cancelled";
    case "completed":
      return "Past";
    case "provisioning":
      return "Pending";
    case "confirmed":
      if (b.endsAt <= now) return "Past";
      return b.startsAt <= now ? "Current" : "Upcoming";
    default: {
      const unreachable: never = b.status;
      throw new Error(`unknown booking status: ${String(unreachable)}`);
    }
  }
}
