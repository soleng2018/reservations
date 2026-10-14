import { describe, expect, it } from "vitest";
import type { RescheduleResult } from "@/app/reservations/[id]/reschedule/actions";
import {
  historyPos,
  initialReschedule,
  reachableStep,
  rescheduleReducer,
  screenOf,
  stepFromParam,
  type RescheduleEvent,
  type RescheduleState,
} from "./reschedule-flow";

const START = "2026-10-13T13:00:00.000Z";
const LATER = "2026-10-13T15:00:00.000Z";
const LIST = {
  starts: [START, LATER],
  durationMs: 2 * 3_600_000,
  now: "2026-10-12T10:00:00.000Z",
};
const DONE: RescheduleResult = {
  kind: "rescheduled",
  testbedName: "aa bench",
  typeName: "Basic",
  startsAt: START,
  endsAt: "2026-10-13T15:00:00.000Z",
  access: null,
};
const error = (
  code: Extract<RescheduleResult, { kind: "error" }>["code"],
): RescheduleResult => ({ kind: "error", code });

const run = (s: RescheduleState, ...events: readonly RescheduleEvent[]) =>
  events.reduce(rescheduleReducer, s);

const atTime = () =>
  run(
    initialReschedule(),
    { type: "starts_loading" },
    { type: "starts_done", result: LIST, at: 1_000 },
  );
const atConfirm = () =>
  run(
    atTime(),
    { type: "pick_day", key: "2026-10-13" },
    { type: "pick_start", iso: START },
    { type: "go", step: "confirm" },
  );
const inProgress = (id = 1) => run(atConfirm(), { type: "submit", id });
const replied = (result: RescheduleResult | "thrown", id = 1) =>
  run(inProgress(id), { type: "reschedule_done", id, result });

// covers: AC-7, AC-10, AC-12
describe("rescheduleReducer, Step 2", () => {
  it("opens on Step 2 with no day or start picked", () => {
    const s = initialReschedule();
    expect(screenOf(s)).toBe("time");
    expect(s).toMatchObject({ day: null, pick: null, step: "time" });
  });

  it("keeps a pick still free on reload and drops a taken one", () => {
    const picked = run(atTime(), { type: "pick_start", iso: START });
    const kept = run(picked, {
      type: "starts_done",
      result: LIST,
      at: 2_000,
    });
    expect(kept).toMatchObject({ pick: START, dropped: false });
    const dropped = run(picked, {
      type: "starts_done",
      result: { ...LIST, starts: [LATER] },
      at: 2_000,
    });
    expect(dropped).toMatchObject({ pick: null, dropped: true });
  });

  it("shows Retry on a limited or thrown load and keeps the pick", () => {
    const picked = run(atTime(), { type: "pick_start", iso: START });
    for (const result of [{ limited: true } as const, "thrown" as const])
      expect(
        run(picked, { type: "starts_done", result, at: 2_000 }),
      ).toMatchObject({ startsStatus: "failed", pick: START });
  });

  it("leaves when the booking is gone", () => {
    expect(run(atTime(), { type: "gone" }).gone).toBe(true);
  });

  it("goes to Step 3 only with a pick", () => {
    expect(run(atTime(), { type: "go", step: "confirm" }).step).toBe("time");
    expect(atConfirm()).toMatchObject({
      step: "confirm",
      preview: { kind: "loading" },
    });
  });

  it("treats ?step=3 with no pick as Step 2", () => {
    expect(stepFromParam("3")).toBe("confirm");
    expect(stepFromParam(null)).toBe("time");
    expect(reachableStep(initialReschedule(), "confirm")).toBe("time");
  });
});

// covers: AC-8
describe("rescheduleReducer, Step 3", () => {
  it("shows the previewed testbed and end", () => {
    const s = run(atConfirm(), {
      type: "preview_done",
      result: { kind: "ok", testbedName: "aa bench", endsAt: LATER },
    });
    expect(s.preview).toEqual({
      kind: "ok",
      testbedName: "aa bench",
      endsAt: LATER,
    });
  });

  it("sends a taken preview back to Step 2 with the message", () => {
    const s = run(atConfirm(), {
      type: "preview_done",
      result: { kind: "taken" },
    });
    expect(s).toMatchObject({ step: "time", pick: null, dropped: true });
  });

  it.each([{ kind: "limited" } as const, "thrown" as const])(
    "falls back to Assigned when you confirm for %o",
    (result) => {
      expect(
        run(atConfirm(), { type: "preview_done", result }).preview,
      ).toEqual({ kind: "fallback" });
    },
  );

  it("goes back to Step 2 keeping the pick, and asks for a new preview on return", () => {
    const back = run(
      atConfirm(),
      { type: "preview_done", result: { kind: "limited" } },
      { type: "go", step: "time" },
    );
    expect(back).toMatchObject({ step: "time", pick: START });
    expect(run(back, { type: "go", step: "confirm" }).preview).toEqual({
      kind: "loading",
    });
  });
});

// covers: AC-10, AC-11
describe("rescheduleReducer, submit", () => {
  it("shows progress and ticks only for the latest submit", () => {
    const s = run(
      inProgress(2),
      { type: "tick", id: 1, ticks: 2 },
      { type: "tick", id: 2, ticks: 1 },
    );
    expect(screenOf(s)).toBe("progress");
    expect(s.ticks).toBe(1);
  });

  it("ignores a reply for an older submit", () => {
    const s = run(inProgress(2), {
      type: "reschedule_done",
      id: 1,
      result: DONE,
    });
    expect(s).toMatchObject({ phase: "progress", done: null });
  });

  it("shows success after rescheduled", () => {
    const s = replied(DONE);
    expect(s).toMatchObject({ ticks: 3, done: DONE, phase: "progress" });
    expect(screenOf(run(s, { type: "show_success", id: 1 }))).toBe("success");
  });

  it("sends slot_taken back to Step 2 with the message and no pick", () => {
    expect(replied(error("slot_taken"))).toMatchObject({
      phase: "editing",
      step: "time",
      pick: null,
      dropped: true,
      sameTime: false,
    });
  });

  it("sends same_time back to Step 2 with its own message", () => {
    const s = replied(error("same_time"));
    expect(s).toMatchObject({
      step: "time",
      pick: null,
      dropped: false,
      sameTime: true,
    });
    // A new pick clears it.
    expect(run(s, { type: "pick_day", key: "2026-10-14" }).sameTime).toBe(
      false,
    );
  });

  it("leaves for the list on stale", () => {
    expect(replied(error("stale")).gone).toBe(true);
  });

  it("returns to Step 3 with the message on limited", () => {
    expect(replied(error("limited"))).toMatchObject({
      phase: "editing",
      step: "confirm",
      confirmLimited: true,
    });
  });

  it.each(["invalid", "unavailable"] as const)(
    "fails with nothing changed on %s",
    (code) => {
      expect(replied(error(code))).toMatchObject({
        phase: "failure",
        failure: "unchanged",
      });
    },
  );

  it("fails with an unknown outcome when the action throws", () => {
    expect(replied("thrown")).toMatchObject({
      phase: "failure",
      failure: "unknown",
    });
  });

  it("goes back to Step 3 from failure, or tries again with a new id", () => {
    const failed = replied("thrown");
    expect(run(failed, { type: "failure_back" })).toMatchObject({
      phase: "editing",
      step: "confirm",
    });
    const again = run(failed, { type: "submit", id: 2 });
    expect(again).toMatchObject({
      phase: "progress",
      submitId: 2,
      failure: null,
      pick: START,
    });
  });

  it("ignores Back and Forward while not editing", () => {
    expect(run(inProgress(), { type: "go", step: "time" }).phase).toBe(
      "progress",
    );
  });

  it("holds history on the Step 3 entry outside editing", () => {
    expect(historyPos(atTime())).toBe(0);
    expect(historyPos(atConfirm())).toBe(1);
    expect(historyPos(inProgress())).toBe(1);
    expect(historyPos(replied("thrown"))).toBe(1);
  });
});
