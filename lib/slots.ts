// Offerable start times (spec 0004 AC-3, AC-5). Pure: the caller passes the
// clock (DB now()) and the busy ranges. Starts sit on UTC :00 and :30, the
// same grid as the bookings_starts_on_half_hour CHECK.

export const SLOT_MS = 30 * 60 * 1000;
export const LEAD_MS = 60 * 60 * 1000; // 1 hour
export const HORIZON_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

export type BusyRange = {
  readonly testbedId: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
};

export const isOnSlotGrid = (d: Date): boolean => d.getTime() % SLOT_MS === 0;

// The server recheck at confirm: on the grid, at least the lead time away,
// and within the horizon.
export function isOfferableStart(
  start: Date,
  now: Date,
  leadMs: number,
  horizonMs: number,
): boolean {
  const t = start.getTime();
  const n = now.getTime();
  return isOnSlotGrid(start) && t >= n + leadMs && t <= n + horizonMs;
}

// Every offerable start where at least one testbed has no busy range
// overlapping [start, start + duration). Ranges are half open, so back to
// back bookings do not overlap.
export function freeStarts(args: {
  readonly now: Date;
  readonly leadMs: number;
  readonly horizonMs: number;
  readonly durationMs: number;
  readonly testbedIds: readonly string[];
  readonly busy: readonly BusyRange[];
}): readonly Date[] {
  const n = args.now.getTime();
  const first = Math.ceil((n + args.leadMs) / SLOT_MS) * SLOT_MS;
  const last = n + args.horizonMs;
  const count = first > last ? 0 : Math.floor((last - first) / SLOT_MS) + 1;
  const busyOf = (id: string) => args.busy.filter((b) => b.testbedId === id);
  const ranges = args.testbedIds.map(busyOf);
  const isFree = (start: number) => {
    const end = start + args.durationMs;
    return ranges.some((busy) =>
      busy.every(
        (b) => b.endsAt.getTime() <= start || b.startsAt.getTime() >= end,
      ),
    );
  };
  return Array.from({ length: count }, (_, i) => first + i * SLOT_MS)
    .filter(isFree)
    .map((t) => new Date(t));
}
