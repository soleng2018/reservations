// The Step 2 time slice both flows share: /book (spec 0010 AC-4 to AC-6) and
// reschedule (spec 0011 AC-7). Pure; each flow's reducer delegates these
// events here and keeps its own state around the slice.

export type StartsList = {
  readonly starts: readonly string[]; // ISO UTC
  readonly durationMs: number;
  readonly now: string; // DB now(), ISO
  readonly loadedAt: number; // browser time, display freshness only
};

// What a starts load answers (the flow handles anything else first).
export type StartsReply =
  | {
      readonly starts: readonly string[];
      readonly durationMs: number;
      readonly now: string;
    }
  | { readonly limited: true };

export type TimeSlice = {
  readonly starts: StartsList | null;
  readonly startsStatus: "idle" | "loading" | "failed";
  readonly day: string | null; // yyyy-mm-dd in the zone
  readonly pick: string | null; // ISO start
  readonly dropped: boolean; // "That time is no longer available"
};

export const CLEAR_TIME = {
  starts: null,
  startsStatus: "idle",
  day: null,
  pick: null,
  dropped: false,
} as const satisfies TimeSlice;

export type TimeEvent =
  | { readonly type: "starts_loading" }
  | {
      readonly type: "starts_done";
      readonly result: StartsReply | "thrown";
      readonly at: number;
    }
  | { readonly type: "pick_day"; readonly key: string }
  | { readonly type: "pick_start"; readonly iso: string };

// A reload keeps the pick while it is still free, else drops it with the
// message (spec 0010 AC-6).
function startsDone<S extends TimeSlice>(
  s: S,
  result: StartsReply | "thrown",
  at: number,
): S {
  if (result === "thrown" || "limited" in result)
    return { ...s, startsStatus: "failed" };
  const starts: StartsList = { ...result, loadedAt: at };
  const kept = s.pick !== null && result.starts.includes(s.pick);
  return {
    ...s,
    starts,
    startsStatus: "idle",
    pick: kept ? s.pick : null,
    dropped: s.dropped || (s.pick !== null && !kept),
  };
}

export function timeReducer<S extends TimeSlice>(s: S, e: TimeEvent): S {
  switch (e.type) {
    case "starts_loading":
      return { ...s, startsStatus: "loading" };
    case "starts_done":
      return startsDone(s, e.result, e.at);
    case "pick_day":
      return { ...s, day: e.key, pick: null, dropped: false };
    case "pick_start":
      return { ...s, pick: e.iso, dropped: false };
    default: {
      const never: never = e;
      return never;
    }
  }
}
