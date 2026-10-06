import type { DurationUnit } from "./db-enums";

const HOUR_MS = 3_600_000;

// A day is a fixed 24 hour block, not a calendar day, so DST never changes a
// booking's length. The DB enforces value >= 1, so anything else is a bug.
export function durationMs(value: number, unit: DurationUnit): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`invalid duration value: ${value}`);
  }
  switch (unit) {
    case "hours":
      return value * HOUR_MS;
    case "days":
      return value * 24 * HOUR_MS;
    default: {
      const unreachable: never = unit;
      throw new Error(`unknown duration unit: ${String(unreachable)}`);
    }
  }
}
