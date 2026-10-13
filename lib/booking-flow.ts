import type {
  BookState,
  DetailsFields,
  DetailsResult,
  PreviewResult,
  StartsResult,
} from "@/app/book/actions";
import { BOOK_ERRORS } from "./booking-input";
import type { FieldErrors } from "./form-errors";
import { firstName } from "./manage-reservations";

// The /book client flow (spec 0010 AC-2 to AC-12, the state transition
// table). Pure: the component dispatches events and does the side effects
// (actions, history, timers). The screen is the URL step while the phase is
// `editing`, else the phase.

export type Step = "details" | "time" | "confirm";
export type Phase = "editing" | "progress" | "failure" | "success";
export type Screen = Step | Exclude<Phase, "editing">;

export const STEP_PARAM: Readonly<Record<Step, string | null>> = {
  details: null,
  time: "2",
  confirm: "3",
};

export const stepFromParam = (param: string | null): Step =>
  param === "2" ? "time" : param === "3" ? "confirm" : "details";

export const stepUrl = (step: Step): string => {
  const p = STEP_PARAM[step];
  return p === null ? "/book" : `/book?step=${p}`;
};

// The flow's history entries sit in step order: Step 2 is only pushed from
// Step 1 and Step 3 only from Step 2, so the entry for a step is always
// STEP_INDEX[step] after the /book entry, and going back by the difference
// lands on the right step.
export const STEP_INDEX: Readonly<Record<Step, number>> = {
  details: 0,
  time: 1,
  confirm: 2,
};

// Where the flow's history should stand: progress, failure, and success all
// stay on the Step 3 entry (success replaces its URL with /book).
export const historyPos = (s: FlowState): number =>
  s.phase === "editing" ? STEP_INDEX[s.step] : STEP_INDEX.confirm;

export type Booked = Extract<BookState, { kind: "booked" }>;

export type StartsList = {
  readonly starts: readonly string[]; // ISO UTC
  readonly durationMs: number;
  readonly now: string; // DB now(), ISO
  readonly loadedAt: number; // browser time, display freshness only
};

// The Step 1 notice inside the card (AC-3).
export type DetailsNotice =
  | { readonly kind: "none" }
  | { readonly kind: "has_live_booking" }
  | { readonly kind: "type_unavailable" }
  | { readonly kind: "alert"; readonly message: string };

export type Preview =
  | { readonly kind: "loading" }
  | {
      readonly kind: "ok";
      readonly testbedName: string;
      readonly endsAt: string;
    }
  | { readonly kind: "fallback" }; // "Assigned when you confirm"

export type FlowState = {
  readonly step: Step;
  readonly phase: Phase;
  readonly form: DetailsFields;
  // The details that passed the Step 1 check; null until then, and again
  // after any Step 1 edit (so Continue checks again).
  readonly details: DetailsFields | null;
  readonly checking: boolean;
  readonly fields: FieldErrors;
  readonly notice: DetailsNotice;
  readonly starts: StartsList | null;
  readonly startsStatus: "idle" | "loading" | "failed";
  readonly day: string | null; // yyyy-mm-dd in the zone
  readonly pick: string | null; // ISO start
  readonly dropped: boolean; // AC-6 "That time is no longer available"
  readonly preview: Preview;
  readonly token: string | null;
  readonly confirmLimited: boolean;
  readonly submitId: number;
  readonly ticks: number; // progress items ticked, 0 to 3
  readonly failure: "nothing_booked" | "unknown" | null;
  readonly booked: Booked | null;
  // The Step 1 name and email kept for the success card after the details
  // are cleared.
  readonly success: {
    readonly firstName: string;
    readonly email: string;
  } | null;
  readonly resetSignal: number; // bumps after each reply: fresh Turnstile token
};

const EMPTY_FORM: DetailsFields = {
  name: "",
  company: "",
  email: "",
  timezone: "",
  testbedTypeId: "",
};

export const initialFlow = (timezone: string): FlowState => ({
  step: "details",
  phase: "editing",
  form: { ...EMPTY_FORM, timezone },
  details: null,
  checking: false,
  fields: {},
  notice: { kind: "none" },
  starts: null,
  startsStatus: "idle",
  day: null,
  pick: null,
  dropped: false,
  preview: { kind: "loading" },
  token: null,
  confirmLimited: false,
  submitId: 0,
  ticks: 0,
  failure: null,
  booked: null,
  success: null,
  resetSignal: 0,
});

export type FlowEvent =
  | {
      readonly type: "edit";
      readonly field: keyof DetailsFields;
      readonly value: string;
    }
  // The form as sent: the Step 1 values with the zone filled in.
  | { readonly type: "check_started"; readonly form: DetailsFields }
  | {
      readonly type: "check_done";
      readonly form: DetailsFields;
      readonly result: DetailsResult | "thrown";
    }
  | { readonly type: "starts_loading" }
  | {
      readonly type: "starts_done";
      readonly result: StartsResult | "thrown";
      readonly at: number;
    }
  | { readonly type: "pick_day"; readonly key: string }
  | { readonly type: "pick_start"; readonly iso: string }
  // In app Back, browser Back and Forward, and Continue from Step 2.
  | { readonly type: "go"; readonly step: Step }
  | { readonly type: "preview_done"; readonly result: PreviewResult | "thrown" }
  | { readonly type: "token"; readonly token: string | null }
  | { readonly type: "submit"; readonly id: number }
  | { readonly type: "tick"; readonly id: number; readonly ticks: number }
  | {
      readonly type: "book_done";
      readonly id: number;
      readonly result: BookState | "thrown";
    }
  | { readonly type: "show_success"; readonly id: number }
  | { readonly type: "failure_back" };

export const screenOf = (s: FlowState): Screen =>
  s.phase === "editing" ? s.step : s.phase;

// The step a URL step really opens: Step 2 and 3 need checked details, and
// Step 3 a pick (AC-11).
export const reachableStep = (s: FlowState, step: Step): Step =>
  s.details === null
    ? "details"
    : step === "confirm" && !s.pick
      ? "time"
      : step;

const clearTime = {
  starts: null,
  startsStatus: "idle",
  day: null,
  pick: null,
  dropped: false,
} as const;

const enterStep = (s: FlowState, step: Step): FlowState => ({
  ...s,
  step,
  // Each entry to Step 3 asks for a fresh preview and a fresh token (the
  // widget mounts again).
  ...(step === "confirm" && s.step !== "confirm"
    ? { preview: { kind: "loading" }, token: null, confirmLimited: false }
    : {}),
});

const alert = (message: string): DetailsNotice => ({ kind: "alert", message });
const THROWN = "Something went wrong. Try again.";

const sameForm = (a: DetailsFields, b: DetailsFields) =>
  (Object.keys(a) as (keyof DetailsFields)[]).every((k) => a[k] === b[k]);

function checkDone(
  s: FlowState,
  form: DetailsFields,
  result: DetailsResult | "thrown",
): FlowState {
  const done = { ...s, checking: false };
  // An edit while the check ran makes its answer stale: Continue again.
  if (!sameForm(s.form, form)) return done;
  if (result === "thrown") return { ...done, notice: alert(THROWN) };
  if (result.kind === "ok")
    return {
      ...enterStep(done, "time"),
      details: form,
      notice: { kind: "none" },
    };
  switch (result.code) {
    case "invalid":
      return { ...done, fields: result.fields };
    case "has_live_booking":
      return { ...done, notice: { kind: "has_live_booking" } };
    case "type_unavailable":
      return {
        ...done,
        ...clearTime,
        form: { ...s.form, testbedTypeId: "" },
        notice: { kind: "type_unavailable" },
      };
    case "booking_pending":
    case "admin_email":
    case "refused":
    case "limited":
      return { ...done, notice: alert(BOOK_ERRORS[result.code]) };
    default: {
      const never: never = result.code;
      return never;
    }
  }
}

function startsDone(
  s: FlowState,
  result: StartsResult | "thrown",
  at: number,
): FlowState {
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

// AC-9: every bookAction reply lands by cause.
function bookDone(s: FlowState, result: BookState | "thrown"): FlowState {
  const replied = {
    ...s,
    token: null,
    resetSignal: s.resetSignal + 1,
  };
  if (result === "thrown")
    return { ...replied, phase: "failure", failure: "unknown" };
  if (result.kind === "idle")
    return { ...replied, phase: "failure", failure: "unknown" };
  if (result.kind === "booked") return { ...replied, ticks: 3, booked: result };
  const editing = { ...replied, phase: "editing" as const };
  // Back at Step 1 the details must pass the check again.
  const toDetails = { ...editing, step: "details" as const, details: null };
  switch (result.code) {
    case "slot_taken":
      return { ...editing, step: "time", pick: null, dropped: true };
    case "has_live_booking":
      return { ...toDetails, notice: { kind: "has_live_booking" } };
    case "booking_pending":
    case "admin_email":
      return { ...toDetails, notice: alert(BOOK_ERRORS[result.code]) };
    case "invalid":
      return { ...toDetails, fields: result.fields };
    case "type_unavailable":
      return {
        ...toDetails,
        ...clearTime,
        form: { ...s.form, testbedTypeId: "" },
        notice: { kind: "type_unavailable" },
      };
    case "limited":
      return { ...editing, step: "confirm", confirmLimited: true };
    case "refused":
    case "unavailable":
    case "gone":
      return { ...replied, phase: "failure", failure: "nothing_booked" };
    default: {
      const never: never = result.code;
      return never;
    }
  }
}

export function flowReducer(s: FlowState, e: FlowEvent): FlowState {
  switch (e.type) {
    case "edit": {
      const form = { ...s.form, [e.field]: e.value };
      const base = { ...s, form, details: null };
      const notice =
        (e.field === "email" && s.notice.kind === "has_live_booking") ||
        (e.field === "testbedTypeId" && s.notice.kind === "type_unavailable")
          ? { kind: "none" as const }
          : s.notice;
      // AC-11: a new lab type or timezone clears the time step.
      return e.field === "testbedTypeId" || e.field === "timezone"
        ? { ...base, ...clearTime, notice }
        : { ...base, notice };
    }
    case "check_started":
      return {
        ...s,
        form: e.form,
        checking: true,
        fields: {},
        notice: { kind: "none" },
      };
    case "check_done":
      return checkDone(s, e.form, e.result);
    case "starts_loading":
      return { ...s, startsStatus: "loading" };
    case "starts_done":
      return s.phase === "editing" ? startsDone(s, e.result, e.at) : s;
    case "pick_day":
      return { ...s, day: e.key, pick: null, dropped: false };
    case "pick_start":
      return { ...s, pick: e.iso, dropped: false };
    case "go":
      return s.phase === "editing" ? enterStep(s, reachableStep(s, e.step)) : s;
    case "preview_done": {
      if (s.phase !== "editing" || s.step !== "confirm") return s;
      const r = e.result;
      if (r !== "thrown" && r.kind === "taken")
        return { ...s, step: "time", pick: null, dropped: true };
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
    case "token":
      return { ...s, token: e.token };
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
    case "book_done":
      return e.id === s.submitId && s.phase === "progress"
        ? bookDone(s, e.result)
        : s;
    case "show_success": {
      if (e.id !== s.submitId || !s.booked || s.phase !== "progress") return s;
      const details = s.details ?? s.form;
      return {
        ...initialFlow(details.timezone),
        phase: "success",
        submitId: s.submitId,
        booked: s.booked,
        resetSignal: s.resetSignal,
        success: {
          firstName: firstName(details.name),
          email: details.email.trim(),
        },
      };
    }
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
