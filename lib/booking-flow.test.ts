import { describe, expect, it } from "vitest";
import type { BookState, DetailsFields } from "@/app/book/actions";
import {
  flowReducer,
  historyPos,
  initialFlow,
  reachableStep,
  screenOf,
  stepFromParam,
  stepUrl,
  type FlowEvent,
  type FlowState,
} from "./booking-flow";
import { BOOK_ERRORS } from "./booking-input";

const TYPE = "6f1c2f9e-0000-4000-8000-000000000001";
const OTHER_TYPE = "6f1c2f9e-0000-4000-8000-000000000002";
const FORM: DetailsFields = {
  name: "  Priya Raman ",
  company: "Acme",
  email: "priya@example.test",
  timezone: "America/New_York",
  testbedTypeId: TYPE,
};
const START = "2026-10-13T13:00:00.000Z";
const LATER = "2026-10-13T15:00:00.000Z";
const LIST = {
  starts: [START, LATER],
  durationMs: 4 * 3_600_000,
  now: "2026-10-12T10:00:00.000Z",
};
const BOOKED: BookState = {
  kind: "booked",
  typeName: "Basic",
  testbedName: "aa bench",
  startsAt: START,
  endsAt: "2026-10-13T17:00:00.000Z",
  timezone: "America/New_York",
  newUser: true,
};
const error = (code: Exclude<BookState, { kind: "booked" | "idle" }>["code"]) =>
  ({ kind: "error", code, fields: {} }) as const;

const run = (s: FlowState, ...events: readonly FlowEvent[]) =>
  events.reduce(flowReducer, s);

// Step 1 passed, Step 2 loaded and picked, Step 3 with a token.
const atDetails = () => initialFlow("");
const atTime = () =>
  run(
    atDetails(),
    { type: "check_started", form: FORM },
    { type: "check_done", form: FORM, result: { kind: "ok" } },
    { type: "starts_loading" },
    { type: "starts_done", result: LIST, at: 1_000 },
  );
const atConfirm = () =>
  run(
    atTime(),
    { type: "pick_day", key: "2026-10-13" },
    { type: "pick_start", iso: START },
    { type: "go", step: "confirm" },
    { type: "token", token: "tok" },
  );
const inProgress = (id = 1) => run(atConfirm(), { type: "submit", id });

// covers: spec 0010 AC-2, AC-3, AC-6, AC-7, AC-8, AC-9, AC-10, AC-11
describe("the step URL (AC-11)", () => {
  it("maps ?step to a step and back", () => {
    expect(stepFromParam(null)).toBe("details");
    expect(stepFromParam("2")).toBe("time");
    expect(stepFromParam("3")).toBe("confirm");
    expect(stepFromParam("9")).toBe("details");
    expect(stepUrl("details")).toBe("/book");
    expect(stepUrl("time")).toBe("/book?step=2");
    expect(stepUrl("confirm")).toBe("/book?step=3");
  });

  it("keeps progress, failure, and success on the Step 3 entry", () => {
    expect(historyPos(atTime())).toBe(1);
    expect(historyPos(inProgress())).toBe(2);
  });
});

describe("Step 1 (AC-2, AC-3)", () => {
  it("moves to Step 2 on ok, keeping the checked details", () => {
    const s = run(
      atDetails(),
      { type: "check_started", form: FORM },
      { type: "check_done", form: FORM, result: { kind: "ok" } },
    );
    expect(screenOf(s)).toBe("time");
    expect(s.details).toEqual(FORM);
    expect(s.checking).toBe(false);
  });

  it("is checking between Continue and the reply", () => {
    const s = run(atDetails(), { type: "check_started", form: FORM });
    expect(s.checking).toBe(true);
    expect(s.form).toEqual(FORM);
  });

  it("shows field errors on invalid", () => {
    const fields = { email: "Enter a valid email address." };
    const s = run(
      atDetails(),
      { type: "check_started", form: FORM },
      {
        type: "check_done",
        form: FORM,
        result: { kind: "error", code: "invalid", fields },
      },
    );
    expect(screenOf(s)).toBe("details");
    expect(s.fields).toEqual(fields);
    expect(s.notice).toEqual({ kind: "none" });
  });

  it("shows the active reservation panel, cleared by editing the email", () => {
    const s = run(
      atDetails(),
      { type: "check_started", form: FORM },
      {
        type: "check_done",
        form: FORM,
        result: { kind: "error", code: "has_live_booking", fields: {} },
      },
    );
    expect(s.notice).toEqual({ kind: "has_live_booking" });
    expect(
      run(s, { type: "edit", field: "name", value: "P" }).notice.kind,
    ).toBe("has_live_booking");
    expect(
      run(s, { type: "edit", field: "email", value: "x@example.test" }).notice,
    ).toEqual({ kind: "none" });
  });

  it.each(["booking_pending", "admin_email", "refused", "limited"] as const)(
    "shows %s in the alert",
    (code) => {
      const s = run(
        atDetails(),
        { type: "check_started", form: FORM },
        {
          type: "check_done",
          form: FORM,
          result: { kind: "error", code, fields: {} },
        },
      );
      expect(s.notice).toEqual({ kind: "alert", message: BOOK_ERRORS[code] });
      expect(s.fields).toEqual({});
    },
  );

  it("deselects a type that went away and keeps every other input", () => {
    const s = run(
      atDetails(),
      { type: "check_started", form: FORM },
      {
        type: "check_done",
        form: FORM,
        result: { kind: "error", code: "type_unavailable", fields: {} },
      },
    );
    expect(s.notice).toEqual({ kind: "type_unavailable" });
    expect(s.form).toEqual({ ...FORM, testbedTypeId: "" });
    expect(
      run(s, { type: "edit", field: "testbedTypeId", value: OTHER_TYPE })
        .notice,
    ).toEqual({ kind: "none" });
  });

  it("shows the generic message when the check throws", () => {
    const s = run(
      atDetails(),
      { type: "check_started", form: FORM },
      { type: "check_done", form: FORM, result: "thrown" },
    );
    expect(s.notice).toEqual({
      kind: "alert",
      message: "Something went wrong. Try again.",
    });
  });

  it("clears the last answer's field errors and notice when Continue runs again", () => {
    const refused = run(
      atDetails(),
      { type: "check_started", form: FORM },
      {
        type: "check_done",
        form: FORM,
        result: { kind: "error", code: "invalid", fields: { name: "Enter" } },
      },
      { type: "edit", field: "email", value: "x@example.test" },
    );
    const again = run(refused, {
      type: "check_started",
      form: { ...FORM, email: "x@example.test" },
    });
    expect(again.fields).toEqual({});
    expect(again.notice).toEqual({ kind: "none" });
  });

  it("drops a reply when the form changed while the check ran", () => {
    const s = run(
      atDetails(),
      { type: "check_started", form: FORM },
      { type: "edit", field: "name", value: "Someone else" },
      { type: "check_done", form: FORM, result: { kind: "ok" } },
    );
    expect(screenOf(s)).toBe("details");
    expect(s.details).toBeNull();
    expect(s.checking).toBe(false);
  });
});

describe("going back to Step 1 (AC-11)", () => {
  it("keeps the pick when only the name changes", () => {
    const back = run(atConfirm(), { type: "go", step: "details" });
    expect(screenOf(back)).toBe("details");
    const edited = run(back, { type: "edit", field: "name", value: "Pri" });
    expect(edited.pick).toBe(START);
    expect(edited.details).toBeNull(); // Continue checks again
  });

  it.each(["testbedTypeId", "timezone"] as const)(
    "clears the pick, the day, and the starts when %s changes",
    (field) => {
      const s = run(
        atConfirm(),
        { type: "go", step: "details" },
        { type: "edit", field, value: "x" },
      );
      expect(s.pick).toBeNull();
      expect(s.day).toBeNull();
      expect(s.starts).toBeNull();
    },
  );
});

describe("Step 2 (AC-4, AC-6)", () => {
  it("opens with no day picked", () => {
    expect(atTime().day).toBeNull();
    expect(atTime().starts?.starts).toEqual(LIST.starts);
  });

  it("clears the start when another day is picked", () => {
    const s = run(
      atTime(),
      { type: "pick_day", key: "2026-10-13" },
      { type: "pick_start", iso: START },
      { type: "pick_day", key: "2026-10-14" },
    );
    expect(s.day).toBe("2026-10-14");
    expect(s.pick).toBeNull();
  });

  it("keeps a pick a reload still offers", () => {
    const s = run(
      atTime(),
      { type: "pick_start", iso: START },
      { type: "starts_done", result: LIST, at: 2_000 },
    );
    expect(s.pick).toBe(START);
    expect(s.dropped).toBe(false);
    expect(s.starts?.loadedAt).toBe(2_000);
  });

  it("drops a pick a reload no longer offers, with the message", () => {
    const s = run(
      atTime(),
      { type: "pick_start", iso: START },
      { type: "starts_done", result: { ...LIST, starts: [LATER] }, at: 2_000 },
    );
    expect(s.pick).toBeNull();
    expect(s.dropped).toBe(true);
    expect(run(s, { type: "pick_start", iso: LATER }).dropped).toBe(false);
  });

  it.each([{ limited: true } as const, "thrown" as const])(
    "keeps the pick and the list when a reload fails (%o)",
    (result) => {
      const s = run(
        atTime(),
        { type: "pick_start", iso: START },
        { type: "starts_loading" },
        { type: "starts_done", result, at: 2_000 },
      );
      expect(s.startsStatus).toBe("failed");
      expect(s.pick).toBe(START);
      expect(s.starts?.starts).toEqual(LIST.starts);
    },
  );

  it("moves to Step 3 only with a pick", () => {
    expect(screenOf(run(atTime(), { type: "go", step: "confirm" }))).toBe(
      "time",
    );
    expect(screenOf(atConfirm())).toBe("confirm");
  });

  it("goes back to Step 1 with the details kept", () => {
    const s = run(atTime(), { type: "go", step: "details" });
    expect(screenOf(s)).toBe("details");
    expect(s.form).toEqual(FORM);
  });
});

describe("Step 3 (AC-7)", () => {
  it("previews on entry, with a fresh token each time", () => {
    const s = atConfirm();
    expect(s.preview).toEqual({ kind: "loading" });
    const again = run(
      s,
      { type: "go", step: "time" },
      { type: "go", step: "confirm" },
    );
    expect(again.token).toBeNull();
    expect(again.preview).toEqual({ kind: "loading" });
  });

  it("names the previewed testbed", () => {
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

  it("sends the guest back to Step 2 when the time is taken", () => {
    const s = run(atConfirm(), {
      type: "preview_done",
      result: { kind: "taken" },
    });
    expect(screenOf(s)).toBe("time");
    expect(s.pick).toBeNull();
    expect(s.dropped).toBe(true);
  });

  it.each([{ kind: "limited" } as const, "thrown" as const])(
    "falls back to 'Assigned when you confirm' (%o)",
    (result) => {
      const s = run(atConfirm(), { type: "preview_done", result });
      expect(screenOf(s)).toBe("confirm");
      expect(s.preview).toEqual({ kind: "fallback" });
    },
  );

  it.each([
    { kind: "taken" } as const,
    { kind: "ok", testbedName: "aa bench", endsAt: LATER } as const,
  ])(
    "ignores a preview that lands after the guest went back to Step 2 (%o)",
    (result) => {
      const back = run(atConfirm(), { type: "go", step: "time" });
      const s = run(back, { type: "preview_done", result });
      expect(s).toBe(back);
      expect(s.pick).toBe(START);
      expect(s.dropped).toBe(false);
    },
  );

  it("forgets an expired token", () => {
    expect(run(atConfirm(), { type: "token", token: null }).token).toBeNull();
  });

  it("goes back to Step 2 keeping the pick", () => {
    const s = run(atConfirm(), { type: "go", step: "time" });
    expect(screenOf(s)).toBe("time");
    expect(s.pick).toBe(START);
  });
});

describe("submitting (AC-8, AC-9)", () => {
  it("shows progress with nothing ticked", () => {
    const s = inProgress();
    expect(screenOf(s)).toBe("progress");
    expect(s.ticks).toBe(0);
  });

  it("ticks on the timers, never past a reply", () => {
    const s = run(
      inProgress(),
      { type: "tick", id: 1, ticks: 1 },
      { type: "tick", id: 1, ticks: 2 },
    );
    expect(s.ticks).toBe(2);
    expect(run(s, { type: "tick", id: 1, ticks: 1 }).ticks).toBe(2);
  });

  it("ignores ticks and replies of an older submit", () => {
    const s = inProgress(2);
    expect(run(s, { type: "tick", id: 1, ticks: 2 }).ticks).toBe(0);
    expect(run(s, { type: "book_done", id: 1, result: BOOKED })).toBe(s);
  });

  it("ticks everything on booked, then shows success and clears the details", () => {
    const booked = run(inProgress(), {
      type: "book_done",
      id: 1,
      result: BOOKED,
    });
    expect(screenOf(booked)).toBe("progress");
    expect(booked.ticks).toBe(3);
    const done = run(booked, { type: "show_success", id: 1 });
    expect(screenOf(done)).toBe("success");
    expect(done.booked).toEqual(BOOKED);
    expect(done.success).toEqual({
      firstName: "Priya",
      email: "priya@example.test",
    });
    expect(done.details).toBeNull();
    expect(done.form.email).toBe("");
    expect(done.pick).toBeNull();
  });

  it("sends slot_taken back to Step 2 with the message", () => {
    const s = run(inProgress(), {
      type: "book_done",
      id: 1,
      result: error("slot_taken"),
    });
    expect(screenOf(s)).toBe("time");
    expect(s.pick).toBeNull();
    expect(s.dropped).toBe(true);
    expect(historyPos(s)).toBe(1);
  });

  it("sends has_live_booking back to Step 1 with the panel", () => {
    const s = run(inProgress(), {
      type: "book_done",
      id: 1,
      result: error("has_live_booking"),
    });
    expect(screenOf(s)).toBe("details");
    expect(s.notice).toEqual({ kind: "has_live_booking" });
    expect(s.details).toBeNull();
  });

  it.each(["booking_pending", "admin_email"] as const)(
    "sends %s back to Step 1 with the alert",
    (code) => {
      const s = run(inProgress(), {
        type: "book_done",
        id: 1,
        result: error(code),
      });
      expect(screenOf(s)).toBe("details");
      expect(s.notice).toEqual({ kind: "alert", message: BOOK_ERRORS[code] });
    },
  );

  it("sends invalid back to Step 1 with field errors", () => {
    const s = run(inProgress(), {
      type: "book_done",
      id: 1,
      result: { kind: "error", code: "invalid", fields: { name: "Enter" } },
    });
    expect(screenOf(s)).toBe("details");
    expect(s.fields).toEqual({ name: "Enter" });
  });

  it("keeps limited on Step 3 with the message", () => {
    const s = run(inProgress(), {
      type: "book_done",
      id: 1,
      result: error("limited"),
    });
    expect(screenOf(s)).toBe("confirm");
    expect(s.confirmLimited).toBe(true);
  });

  it.each(["refused", "unavailable", "gone"] as const)(
    "shows the nothing booked failure for %s",
    (code) => {
      const s = run(inProgress(), {
        type: "book_done",
        id: 1,
        result: error(code),
      });
      expect(screenOf(s)).toBe("failure");
      expect(s.failure).toBe("nothing_booked");
    },
  );

  it("shows the hedged failure when the reply is lost", () => {
    const s = run(inProgress(), { type: "book_done", id: 1, result: "thrown" });
    expect(screenOf(s)).toBe("failure");
    expect(s.failure).toBe("unknown");
  });

  it("treats an idle reply as a lost one", () => {
    const s = run(inProgress(), {
      type: "book_done",
      id: 1,
      result: { kind: "idle" },
    });
    expect(screenOf(s)).toBe("failure");
    expect(s.failure).toBe("unknown");
  });

  it("sends type_unavailable back to Step 1 with the type deselected", () => {
    const s = run(inProgress(), {
      type: "book_done",
      id: 1,
      result: error("type_unavailable"),
    });
    expect(screenOf(s)).toBe("details");
    expect(s.notice).toEqual({ kind: "type_unavailable" });
    expect(s.form).toEqual({ ...FORM, testbedTypeId: "" });
    expect(s.details).toBeNull();
    expect(s.pick).toBeNull();
    expect(s.starts).toBeNull();
  });

  it("clears the limited message when the guest confirms again", () => {
    const limited = run(inProgress(), {
      type: "book_done",
      id: 1,
      result: error("limited"),
    });
    const again = run(
      limited,
      { type: "token", token: "fresh" },
      { type: "submit", id: 2 },
    );
    expect(again.confirmLimited).toBe(false);
    expect(screenOf(again)).toBe("progress");
  });

  it("shows success only for the latest booked submit", () => {
    const booked = run(inProgress(2), {
      type: "book_done",
      id: 2,
      result: BOOKED,
    });
    expect(run(booked, { type: "show_success", id: 1 })).toBe(booked);
    const unbooked = inProgress();
    expect(run(unbooked, { type: "show_success", id: 1 })).toBe(unbooked);
  });

  it("ignores ticks once the reply has landed", () => {
    const failed = run(inProgress(), {
      type: "book_done",
      id: 1,
      result: "thrown",
    });
    expect(run(failed, { type: "tick", id: 1, ticks: 2 })).toBe(failed);
  });

  it("greets a one word or oddly spaced name by its first word", () => {
    const withName = (name: string) => {
      const form = { ...FORM, name };
      const done = run(
        atDetails(),
        { type: "check_started", form },
        { type: "check_done", form, result: { kind: "ok" } },
        { type: "starts_done", result: LIST, at: 1_000 },
        { type: "pick_start", iso: START },
        { type: "go", step: "confirm" },
        { type: "token", token: "tok" },
        { type: "submit", id: 1 },
        { type: "book_done", id: 1, result: BOOKED },
        { type: "show_success", id: 1 },
      );
      return done.success?.firstName;
    };
    expect(withName("Madonna")).toBe("Madonna");
    expect(withName("\tAna  María López")).toBe("Ana");
  });

  it("only leaves failure through Back", () => {
    const s = atConfirm();
    expect(run(s, { type: "failure_back" })).toBe(s);
  });

  it("resets the widget and forgets the token after every reply", () => {
    const before = inProgress();
    const s = run(before, { type: "book_done", id: 1, result: "thrown" });
    expect(s.token).toBeNull();
    expect(s.resetSignal).toBe(before.resetSignal + 1);
  });

  it("goes from failure back to Step 3, or tries again with a new id", () => {
    const failed = run(inProgress(), {
      type: "book_done",
      id: 1,
      result: "thrown",
    });
    expect(screenOf(run(failed, { type: "failure_back" }))).toBe("confirm");
    const retry = run(
      failed,
      { type: "token", token: "fresh" },
      { type: "submit", id: 2 },
    );
    expect(screenOf(retry)).toBe("progress");
    expect(retry.submitId).toBe(2);
    expect(retry.details).toEqual(FORM);
  });
});

describe("browser Back and Forward (AC-11)", () => {
  it("are ignored outside editing", () => {
    const s = inProgress();
    expect(run(s, { type: "go", step: "time" })).toBe(s);
  });

  it("are ignored on the failure and success screens too", () => {
    const failed = run(inProgress(), {
      type: "book_done",
      id: 1,
      result: "thrown",
    });
    const succeeded = run(
      inProgress(),
      { type: "book_done", id: 1, result: BOOKED },
      { type: "show_success", id: 1 },
    );
    expect(run(failed, { type: "go", step: "time" })).toBe(failed);
    expect(run(succeeded, { type: "go", step: "details" })).toBe(succeeded);
    expect(historyPos(failed)).toBe(2);
    expect(historyPos(succeeded)).toBe(2);
  });

  it("cannot open Step 2 or 3 without checked details", () => {
    const s = atDetails();
    expect(reachableStep(s, "time")).toBe("details");
    expect(screenOf(run(s, { type: "go", step: "confirm" }))).toBe("details");
  });

  it("cannot open Step 3 without a pick", () => {
    expect(reachableStep(atTime(), "confirm")).toBe("time");
  });

  it("ignores a late starts reply while a submit runs", () => {
    const s = inProgress();
    expect(
      run(s, { type: "starts_done", result: { ...LIST, starts: [] }, at: 9 }),
    ).toBe(s);
  });
});
