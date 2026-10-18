import { describe, expect, it } from "vitest";
import {
  CLEAR_TIME,
  timeReducer,
  type StartsReply,
  type TimeEvent,
  type TimeSlice,
} from "./time-pick";

// The Step 2 slice both /book (spec 0010 AC-4 to AC-6) and reschedule
// (spec 0011 AC-7) delegate to.

const START = "2026-10-13T09:00:00.000Z";
const LATER = "2026-10-13T10:00:00.000Z";
const NOW = "2026-10-13T08:00:00.000Z";
const HOURS_2 = 7_200_000;

const reply = (starts: readonly string[]): StartsReply => ({
  starts,
  durationMs: HOURS_2,
  now: NOW,
});

const run = <S extends TimeSlice>(s: S, ...events: readonly TimeEvent[]) =>
  events.reduce(timeReducer<S>, s);

const loaded = (starts: readonly string[] = [START, LATER]) =>
  run<TimeSlice>(CLEAR_TIME, {
    type: "starts_done",
    result: reply(starts),
    at: 1_000,
  });

describe("timeReducer", () => {
  it("marks the slice loading", () => {
    const s = run<TimeSlice>(CLEAR_TIME, { type: "starts_loading" });

    expect(s.startsStatus).toBe("loading");
  });

  // covers: spec 0011 AC-7
  it("stores a loaded list with the browser time it arrived", () => {
    const s = run<TimeSlice>(
      CLEAR_TIME,
      { type: "starts_loading" },
      { type: "starts_done", result: reply([START]), at: 42 },
    );

    expect(s.startsStatus).toBe("idle");
    expect(s.starts).toEqual({
      starts: [START],
      durationMs: HOURS_2,
      now: NOW,
      loadedAt: 42,
    });
  });

  it("accepts an empty list without a pick or a dropped message", () => {
    const s = loaded([]);

    expect(s.starts?.starts).toEqual([]);
    expect(s.pick).toBeNull();
    expect(s.dropped).toBe(false);
  });

  it.each([{ limited: true } as const, "thrown" as const])(
    "keeps the previous list and pick when a reload fails (%o)",
    (result) => {
      const before = run(loaded(), { type: "pick_start", iso: START });

      const s = run(before, { type: "starts_done", result, at: 2_000 });

      expect(s.startsStatus).toBe("failed");
      expect(s.starts).toBe(before.starts);
      expect(s.pick).toBe(START);
      expect(s.dropped).toBe(false);
    },
  );

  it("recovers from a failed load on the next good one", () => {
    const failed = run<TimeSlice>(CLEAR_TIME, {
      type: "starts_done",
      result: "thrown",
      at: 1,
    });

    const s = run(failed, {
      type: "starts_done",
      result: reply([START]),
      at: 2,
    });

    expect(s.startsStatus).toBe("idle");
    expect(s.starts?.starts).toEqual([START]);
  });

  // covers: spec 0010 AC-6
  it("keeps the dropped message across a later reload that has nothing to drop", () => {
    const dropped = run(
      loaded(),
      { type: "pick_start", iso: START },
      { type: "starts_done", result: reply([LATER]), at: 2_000 },
    );

    const s = run(dropped, {
      type: "starts_done",
      result: reply([START, LATER]),
      at: 3_000,
    });

    expect(dropped.dropped).toBe(true);
    expect(s.pick).toBeNull();
    expect(s.dropped).toBe(true);
  });

  it("does not raise the dropped message when nothing was picked", () => {
    const s = run(loaded(), {
      type: "starts_done",
      result: reply([LATER]),
      at: 2_000,
    });

    expect(s.dropped).toBe(false);
  });

  it("clears the pick and the dropped message when the day changes", () => {
    const dropped = run(
      loaded(),
      { type: "pick_start", iso: START },
      { type: "starts_done", result: reply([LATER]), at: 2_000 },
    );

    const s = run(dropped, { type: "pick_day", key: "2026-10-14" });

    expect(s.day).toBe("2026-10-14");
    expect(s.pick).toBeNull();
    expect(s.dropped).toBe(false);
  });

  it("keeps the day when a start is picked", () => {
    const s = run(
      loaded(),
      { type: "pick_day", key: "2026-10-13" },
      { type: "pick_start", iso: LATER },
    );

    expect(s.day).toBe("2026-10-13");
    expect(s.pick).toBe(LATER);
  });

  it("leaves the flow's own fields alone and never mutates its input", () => {
    const before = Object.freeze({ ...loaded(), phase: "editing", version: 3 });

    const s = run(
      before,
      { type: "starts_loading" },
      { type: "pick_day", key: "2026-10-13" },
      { type: "pick_start", iso: START },
      { type: "starts_done", result: reply([LATER]), at: 2_000 },
    );

    expect(s.phase).toBe("editing");
    expect(s.version).toBe(3);
    expect(before.pick).toBeNull();
    expect(before.startsStatus).toBe("idle");
  });
});
