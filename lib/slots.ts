// Offerable start times (spec 0004 AC-3, AC-5). Pure: the caller passes the
// clock (DB now()) and the busy ranges. Starts sit on UTC :00 and :30, the
// same grid as the bookings_starts_on_half_hour CHECK.

export const SLOT_MS = 30 * 60 * 1000;
export const LEAD_MS = 60 * 60 * 1000; // 1 hour
// Spec 0020: a live booking holds its testbed this long after ends_at, for the
// cleanup automation. It must equal the interval in the bookings_no_overlap
// constraint (migration 0016); a database test keeps the two in step. LEAD_MS
// stays at least this long, so no start lands in a gap that has begun.
export const GAP_MS = 30 * 60 * 1000; // 30 minutes
export const HORIZON_MS = 90 * 24 * 60 * 60 * 1000; // 90 days (spec 0010)
// Spec 0015 AC-1: the reminder email's lead time, set only here.
export const REMINDER_LEAD_MS = 24 * 60 * 60 * 1000; // 24 hours

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
// within the cleanup gap of [start, start + duration): a busy range ends at
// least GAP_MS before the start, or starts at least GAP_MS after the end
// (spec 0020 AC-2).
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
        (b) =>
          b.endsAt.getTime() + GAP_MS <= start ||
          b.startsAt.getTime() >= end + GAP_MS,
      ),
    );
  };
  return Array.from({ length: count }, (_, i) => first + i * SLOT_MS)
    .filter(isFree)
    .map((t) => new Date(t));
}
