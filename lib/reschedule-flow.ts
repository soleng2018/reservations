import type {
  ReschedulePreviewResult,
  RescheduleResult,
} from "@/app/reservations/[id]/reschedule/actions";
import {
  CLEAR_TIME,
  timeReducer,
  type TimeEvent,
  type TimeSlice,
} from "./time-pick";

// The reschedule client flow (spec 0011 AC-7 to AC-12, the reschedule
// transition table). Pure: the component dispatches events and does the side
// effects (actions, history, timers, navigation). The screen is the URL step
// while the phase is `editing`, else the phase. Step 2 is the time slice
// /book uses (lib/time-pick.ts).

export type RescheduleStep = "time" | "confirm";
export type ReschedulePhase = "editing" | "progress" | "failure" | "success";
export type RescheduleScreen =
  RescheduleStep | Exclude<ReschedulePhase, "editing">;

export const STEP_PARAM: Readonly<Record<RescheduleStep, string>> = {
  time: "2",
  confirm: "3",
};

export const stepFromParam = (param: string | null): RescheduleStep =>
  param === "3" ? "confirm" : "time";

// Step 3 is only pushed from Step 2, so the history entry for a step is
// always STEP_INDEX[step] after the Step 2 entry.
export const STEP_INDEX: Readonly<Record<RescheduleStep, number>> = {
  time: 0,
  confirm: 1,
};

export type Rescheduled = Extract<RescheduleResult, { kind: "rescheduled" }>;

export type ReschedulePreview =
  | { readonly kind: "loading" }
  | {
      readonly kind: "ok";
      readonly testbedName: string;
      readonly endsAt: string;
    }
  | { readonly kind: "fallback" }; // "Assigned when you confirm"

export type RescheduleState = TimeSlice & {
  readonly step: RescheduleStep;
  readonly phase: ReschedulePhase;
  // "That's already your reservation time" on Step 2 (AC-10).
  readonly sameTime: boolean;
  readonly preview: ReschedulePreview;
  readonly confirmLimited: boolean;
  readonly submitId: number;
  readonly ticks: number; // progress items ticked, 0 to 3
  // "unchanged": nothing moved. "unknown": the reply was lost.
  readonly failure: "unchanged" | "unknown" | null;
  readonly done: Rescheduled | null;
  // The booking changed meanwhile: leave for /reservations (AC-5 toast).
  readonly gone: boolean;
};

export const historyPos = (s: RescheduleState): number =>
  s.phase === "editing" ? STEP_INDEX[s.step] : STEP_INDEX.confirm;

export const initialReschedule = (): RescheduleState => ({
  step: "time",
  phase: "editing",
  ...CLEAR_TIME,
  sameTime: false,
  preview: { kind: "loading" },
  confirmLimited: false,
  submitId: 0,
  ticks: 0,
  failure: null,
  done: null,
  gone: false,
});

export type RescheduleEvent =
  | TimeEvent
  // In app Back, browser Back and Forward, and Continue from Step 2.
  | { readonly type: "go"; readonly step: RescheduleStep }
  // A starts load, preview, or reschedule found the booking changed.
  | { readonly type: "gone" }
  | {
      readonly type: "preview_done";
      readonly result:
        Exclude<ReschedulePreviewResult, { kind: "gone" }> | "thrown";
    }
  | { readonly type: "submit"; readonly id: number }
  | { readonly type: "tick"; readonly id: number; readonly ticks: number }
  | {
      readonly type: "reschedule_done";
      readonly id: number;
      readonly result: RescheduleResult | "thrown";
    }
  | { readonly type: "show_success"; readonly id: number }
  | { readonly type: "failure_back" };

export const screenOf = (s: RescheduleState): RescheduleScreen =>
  s.phase === "editing" ? s.step : s.phase;

// Step 3 needs a pick (AC-12): loaded with none, it opens Step 2.
export const reachableStep = (
  s: RescheduleState,
  step: RescheduleStep,
): RescheduleStep => (step === "confirm" && !s.pick ? "time" : step);

const enterStep = (
  s: RescheduleState,
  step: RescheduleStep,
): RescheduleState => ({
  ...s,
  step,
  // Each entry to Step 3 asks for a fresh preview.
  ...(step === "confirm" && s.step !== "confirm"
    ? { preview: { kind: "loading" }, confirmLimited: false }
    : {}),
});

// Back on Step 2 with the pick cleared; entering Step 2 reloads the starts.
const backToTime = (
  s: RescheduleState,
  message: "dropped" | "sameTime",
): RescheduleState => ({
  ...s,
  phase: "editing",
  step: "time",
  pick: null,
  dropped: message === "dropped",
  sameTime: message === "sameTime",
});

// AC-10: every rescheduleAction reply lands by cause.
function rescheduleDone(
  s: RescheduleState,
  result: RescheduleResult | "thrown",
): RescheduleState {
  if (result === "thrown")
    return { ...s, phase: "failure", failure: "unknown" };
  if (result.kind === "rescheduled") return { ...s, ticks: 3, done: result };
  switch (result.code) {
    case "slot_taken":
      return backToTime(s, "dropped");
    case "same_time":
      return backToTime(s, "sameTime");
    case "stale":
      return { ...s, gone: true };
    case "limited":
      return { ...s, phase: "editing", step: "confirm", confirmLimited: true };
    case "invalid":
    case "unavailable":
      return { ...s, phase: "failure", failure: "unchanged" };
    default: {
      const never: never = result.code;
      return never;
    }
  }
}

export function rescheduleReducer(
  s: RescheduleState,
  e: RescheduleEvent,
): RescheduleState {
  switch (e.type) {
    case "starts_loading":
      return timeReducer(s, e);
    case "starts_done":
      return s.phase === "editing" ? timeReducer(s, e) : s;
    case "pick_day":
    case "pick_start":
      return { ...timeReducer(s, e), sameTime: false };
    case "go":
      return s.phase === "editing" ? enterStep(s, reachableStep(s, e.step)) : s;
    case "gone":
      return { ...s, gone: true };
    case "preview_done": {
      if (s.phase !== "editing" || s.step !== "confirm") return s;
      const r = e.result;
      if (r !== "thrown" && r.kind === "taken") return backToTime(s, "dropped");
      return r !== "thrown" && r.kind === "ok"
        ? {
            ...s,
            preview: {
              kind: "ok",
              testbedName: r.testbedName,
              endsAt: r.endsAt,
            },
          }
        : { ...s, preview: { kind: "fallback" } };
    }
    case "submit":
      return {
        ...s,
        phase: "progress",
        submitId: e.id,
        ticks: 0,
        failure: null,
        confirmLimited: false,
      };
    case "tick":
      return e.id === s.submitId && s.phase === "progress"
        ? { ...s, ticks: Math.max(s.ticks, e.ticks) }
        : s;
    case "reschedule_done":
      return e.id === s.submitId && s.phase === "progress"
        ? rescheduleDone(s, e.result)
        : s;
    case "show_success":
      return e.id === s.submitId && s.done && s.phase === "progress"
        ? { ...s, phase: "success" }
        : s;
    case "failure_back":
      return s.phase === "failure"
        ? { ...s, phase: "editing", step: "confirm" }
        : s;
    default: {
      const never: never = e;
      return never;
    }
  }
}
