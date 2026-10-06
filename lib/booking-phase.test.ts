import { describe, expect, it } from "vitest";
import { bookingPhase, type PhaseInput } from "./booking-phase";

const startsAt = new Date("2026-10-06T10:00:00Z");
const endsAt = new Date("2026-10-06T12:00:00Z");
const at = (iso: string) => new Date(iso);

describe("bookingPhase", () => {
  it.each<[PhaseInput["status"], string, string]>([
    ["confirmed", "2026-10-06T09:59:59Z", "Upcoming"],
    ["confirmed", "2026-10-06T10:00:00Z", "Current"],
    ["confirmed", "2026-10-06T11:59:59Z", "Current"],
    ["confirmed", "2026-10-06T12:00:00Z", "Past"],
    ["completed", "2026-10-06T09:00:00Z", "Past"],
    ["cancelled", "2026-10-06T11:00:00Z", "Cancelled"],
    ["cancelled", "2026-10-06T13:00:00Z", "Cancelled"],
    ["provisioning", "2026-10-06T09:00:00Z", "Pending"],
    ["provisioning", "2026-10-06T11:00:00Z", "Pending"],
  ])("%s at %s is %s", (status, now, phase) => {
    expect(bookingPhase({ status, startsAt, endsAt }, at(now))).toBe(phase);
  });
});
