"use client";

import { unstable_rethrow, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircleIcon, RotateCwIcon } from "lucide-react";
import {
  loadRescheduleStartsAction,
  previewRescheduleAction,
  rescheduleAction,
} from "@/app/reservations/[id]/reschedule/actions";
import {
  ConfirmStep,
  type ConfirmSummary,
} from "@/components/book/confirm-step";
import { FailureScreen } from "@/components/book/failure-screen";
import { ProgressScreen } from "@/components/book/progress-screen";
import { BOOK_HEADING_ID, StepHeading } from "@/components/book/step-heading";
import { TimeStep } from "@/components/book/time-step";
import { notifyError } from "@/components/notify";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { RESCHEDULE_MESSAGES } from "@/lib/booking-input";
import { formatDateTime } from "@/lib/format-time";
import {
  historyPos,
  initialReschedule,
  rescheduleReducer,
  screenOf,
  STEP_INDEX,
  STEP_PARAM,
  stepFromParam,
  type RescheduleEvent,
  type RescheduleState,
  type RescheduleStep,
} from "@/lib/reschedule-flow";
import { zoneLabel } from "@/lib/timezones";
import { cn } from "@/lib/utils";
import { RescheduleSuccess } from "./reschedule-success";

const STALE_AFTER_MS = 5 * 60_000; // spec 0010 AC-6, unchanged
const TICKS_AT_MS = [750, 1500] as const; // spec 0010 AC-8 timers
const SUCCESS_AFTER_MS = 400;

const PROGRESS_STEPS = [
  "Updating your reservation",
  "Reassigning your testbed",
  "Confirming your new time",
] as const;

// AC-10: a redirect from requireLearner() (session expired, deactivated) is
// the router's to follow, never a failure the flow shows.
const settle = <T,>(p: Promise<T>): Promise<T | "thrown"> =>
  p.catch((e: unknown) => {
    unstable_rethrow(e);
    return "thrown" as const;
  });

const urlStep = () =>
  stepFromParam(new URLSearchParams(window.location.search).get("step"));

export type RescheduleBooking = {
  readonly id: string;
  readonly version: number; // the version the learner sees
  readonly typeName: string;
  readonly durationLabel: string; // display only; Ends uses the server's
  readonly currentStart: string; // ISO
  readonly current: boolean; // started when the page loaded (display only)
  readonly email: string;
  readonly timezone: string; // the account zone
};

// The reschedule flow (spec 0011 AC-7 to AC-12): Step 2 and Step 3 reuse the
// /book step components, then progress and a success or failure screen. Its
// state lives in memory only; the URL carries just the booking id and step.
export function RescheduleFlow({
  booking,
}: {
  readonly booking: RescheduleBooking;
}) {
  const router = useRouter();
  const base = `/reservations/${booking.id}/reschedule`;
  const stepUrl = useCallback(
    (step: RescheduleStep) => `${base}?step=${STEP_PARAM[step]}`,
    [base],
  );

  const [state, setState] = useState<RescheduleState>(initialReschedule);
  // The latest state for event handlers, kept in step with every send.
  const latest = useRef(state);
  // Popstates caused by our own history.go(), which the flow already shows.
  const selfNav = useRef(0);

  const send = useCallback(
    (event: RescheduleEvent, syncUrl = true) => {
      const prev = latest.current;
      const next = rescheduleReducer(prev, event);
      if (next === prev) return;
      latest.current = next;
      setState(next);
      if (!syncUrl) return;
      if (next.phase === "success" && prev.phase !== "success") {
        window.history.replaceState(null, "", base);
        return;
      }
      if (next.phase !== "editing") return;
      const delta = historyPos(next) - historyPos(prev);
      if (delta > 0) window.history.pushState(null, "", stepUrl(next.step));
      if (delta < 0) {
        selfNav.current += 1;
        window.history.go(delta);
      }
    },
    [base, stepUrl],
  );

  // AC-12: on load there is no pick in memory, so any step opens Step 2.
  useEffect(() => {
    if (window.location.search !== `?step=${STEP_PARAM.time}`)
      window.history.replaceState(null, "", stepUrl("time"));
  }, [stepUrl]);

  // Browser Back and Forward move between the steps while editing;
  // progress, failure, and success ignore them.
  useEffect(() => {
    const onPop = () => {
      if (selfNav.current > 0) {
        selfNav.current -= 1;
        return;
      }
      const s = latest.current;
      const step = urlStep();
      const at = STEP_INDEX[step];
      if (s.phase !== "editing") {
        selfNav.current += 1;
        window.history.go(historyPos(s) - at);
        return;
      }
      send({ type: "go", step }, false);
      const shown = historyPos(latest.current);
      if (shown !== at) {
        selfNav.current += 1;
        window.history.go(shown - at);
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [send]);

  // AC-5, AC-7: the booking changed meanwhile.
  useEffect(() => {
    if (!state.gone) return;
    notifyError(RESCHEDULE_MESSAGES.stale);
    router.replace("/reservations");
  }, [state.gone, router]);

  const screen = screenOf(state);

  // AC-7: the starts load on entering Step 2 (after slot_taken and
  // same_time too).
  const loadStarts = useCallback(async () => {
    send({ type: "starts_loading" });
    const result = await settle(loadRescheduleStartsAction(booking.id));
    if (result !== "thrown" && "gone" in result) send({ type: "gone" });
    else send({ type: "starts_done", result, at: Date.now() });
  }, [booking.id, send]);

  useEffect(() => {
    if (screen === "time") void loadStarts();
  }, [screen, loadStarts]);

  // Back on the tab with a list older than 5 minutes, Step 2 only.
  useEffect(() => {
    if (screen !== "time") return;
    const onVisible = () => {
      const s = latest.current;
      if (
        document.visibilityState === "visible" &&
        s.startsStatus !== "loading" &&
        s.starts !== null &&
        Date.now() - s.starts.loadedAt > STALE_AFTER_MS
      )
        void loadStarts();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [screen, loadStarts]);

  // AC-8: each entry to Step 3 previews the testbed.
  const pick = state.pick;
  const previewing = screen === "confirm" && state.preview.kind === "loading";
  useEffect(() => {
    if (!previewing || !pick) return;
    let live = true;
    settle(previewRescheduleAction(booking.id, pick)).then((result) => {
      if (!live) return;
      if (result !== "thrown" && result.kind === "gone") send({ type: "gone" });
      else send({ type: "preview_done", result });
    });
    return () => {
      live = false;
    };
  }, [previewing, pick, booking.id, send]);

  // A new screen's title takes focus (not on the first render).
  const shownScreen = useRef(screen);
  useEffect(() => {
    if (screen === shownScreen.current) return;
    shownScreen.current = screen;
    document.getElementById(BOOK_HEADING_ID)?.focus();
  }, [screen]);

  // AC-10: one submit at a time; only the latest submit's reply counts.
  const submit = async () => {
    const s = latest.current;
    if (!s.pick || s.phase === "progress") return;
    const id = s.submitId + 1;
    send({ type: "submit", id });
    const timers = TICKS_AT_MS.map((ms, i) =>
      setTimeout(() => send({ type: "tick", id, ticks: i + 1 }), ms),
    );
    const result = await settle(
      rescheduleAction(booking.id, booking.version, s.pick),
    );
    timers.forEach(clearTimeout);
    send({ type: "reschedule_done", id, result });
    if (result !== "thrown" && result.kind === "rescheduled")
      setTimeout(() => send({ type: "show_success", id }), SUCCESS_AFTER_MS);
  };

  const { timezone } = booking;

  if (screen === "success" && state.done)
    return <RescheduleSuccess done={state.done} timezone={timezone} />;

  if (screen === "time")
    return (
      <TimeScreen
        state={state}
        booking={booking}
        onPickDay={(key) => send({ type: "pick_day", key })}
        onPick={(iso) => send({ type: "pick_start", iso })}
        onRetry={() => void loadStarts()}
        onBack={() => router.push("/reservations")}
        onContinue={() => send({ type: "go", step: "confirm" })}
      />
    );

  // AC-8: Ends comes from the preview or the starts reply, never the props.
  const durationMs = state.starts?.durationMs ?? 0;
  const startsAt = pick ? new Date(pick) : null;
  const endsAt =
    state.preview.kind === "ok"
      ? new Date(state.preview.endsAt)
      : startsAt && new Date(startsAt.getTime() + durationMs);
  const summary: ConfirmSummary = {
    eyebrow: "Reschedule",
    title: "Confirm your new time",
    who: [
      { label: "Email", value: booking.email },
      { label: "Lab type", value: booking.typeName },
      {
        label: "Timezone",
        value: zoneLabel(timezone, startsAt ?? new Date()),
      },
      {
        label: "Current time",
        value: formatDateTime(new Date(booking.currentStart), timezone),
        struck: true,
      },
    ],
    when: [
      {
        label: "Starts",
        value: startsAt ? formatDateTime(startsAt, timezone) : "",
        accent: true,
      },
      {
        label: "Ends",
        value: endsAt ? formatDateTime(endsAt, timezone) : "",
        accent: true,
      },
      {
        label: "Testbed assigned",
        value:
          state.preview.kind === "ok"
            ? state.preview.testbedName
            : state.preview.kind === "fallback"
              ? "Assigned when you confirm"
              : "Finding a free testbed",
        accent: true,
      },
    ],
  };
  const running = state.phase === "progress";

  return (
    <div
      className={cn(
        "mx-auto w-full px-5 pb-20",
        screen === "confirm"
          ? "max-w-140 pt-12"
          : "max-w-110 pt-25 max-sm:pt-16",
      )}
    >
      {screen === "confirm" ? (
        <>
          <ConfirmStep
            summary={summary}
            note={
              booking.current
                ? "Your current lab session ends when you confirm."
                : undefined
            }
          />
          {state.confirmLimited ? (
            <Alert variant="destructive" className="mt-4">
              <AlertCircleIcon aria-hidden="true" />
              <AlertDescription>{RESCHEDULE_MESSAGES.limited}</AlertDescription>
            </Alert>
          ) : null}
          <div className="mt-5 flex gap-3">
            <Button
              variant="outline"
              size="lg"
              onClick={() => send({ type: "go", step: "time" })}
            >
              Back
            </Button>
            <Button
              variant="cta"
              size="lg"
              className="flex-1"
              disabled={running}
              onClick={() => void submit()}
            >
              Confirm new time
            </Button>
          </div>
        </>
      ) : screen === "progress" ? (
        <ProgressScreen
          title="Updating your reservation"
          steps={PROGRESS_STEPS}
          ticks={state.ticks}
        />
      ) : (
        <>
          <FailureScreen
            flow="reschedule"
            failure={
              state.failure === "unchanged" ? "nothing_booked" : "unknown"
            }
          />
          <div className="mt-7 flex justify-center gap-3">
            <Button
              variant="outline"
              size="lg"
              onClick={() => send({ type: "failure_back" })}
            >
              Back
            </Button>
            <Button size="lg" onClick={() => void submit()}>
              Try again
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

// Step 2 around the time picker (AC-7): the heading, the load states, the
// dropped pick and same time messages, and Back and Continue.
function TimeScreen({
  state,
  booking,
  onPickDay,
  onPick,
  onRetry,
  onBack,
  onContinue,
}: {
  readonly state: RescheduleState;
  readonly booking: RescheduleBooking;
  readonly onPickDay: (key: string) => void;
  readonly onPick: (iso: string) => void;
  readonly onRetry: () => void;
  readonly onBack: () => void;
  readonly onContinue: () => void;
}) {
  const list = state.starts;
  const empty = list !== null && list.starts.length === 0;
  const message = state.dropped
    ? RESCHEDULE_MESSAGES.slot_taken
    : state.sameTime
      ? RESCHEDULE_MESSAGES.same_time
      : null;
  return (
    <div className="mx-auto w-full max-w-130 px-5 pt-5.5 pb-6 md:max-w-235">
      <StepHeading
        compact
        eyebrow="Reschedule"
        title="Choose a time"
        subtitle={`${booking.typeName} · ${booking.durationLabel}`}
      />

      {message ? (
        <Alert variant="destructive" className="mb-3.5">
          <AlertCircleIcon aria-hidden="true" />
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      ) : null}

      {state.startsStatus === "failed" ? (
        <Alert variant="destructive" className="mb-3.5">
          <AlertCircleIcon aria-hidden="true" />
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            <span>{RESCHEDULE_MESSAGES.limited}</span>
            <Button variant="outline" size="sm" onClick={onRetry}>
              <RotateCwIcon data-icon="inline-start" aria-hidden="true" />
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {list === null ? (
        state.startsStatus === "failed" ? null : (
          <div
            role="status"
            className="flex flex-col gap-3 overflow-hidden rounded-xl border bg-card p-4 shadow-xs md:flex-row"
          >
            <span className="sr-only">Loading free times</span>
            <Skeleton className="h-80 md:w-87" />
            <Skeleton className="h-80 flex-1 max-md:hidden" />
          </div>
        )
      ) : empty ? (
        <p className="rounded-xl border bg-card px-5 py-10 text-center text-cell text-fg2 shadow-xs">
          No free times in the next 90 days.
        </p>
      ) : (
        <TimeStep
          starts={list.starts}
          durationMs={list.durationMs}
          durationLabel={booking.durationLabel}
          now={list.now}
          timezone={booking.timezone}
          day={state.day}
          picked={state.pick}
          currentStart={booking.currentStart}
          onPickDay={onPickDay}
          onPick={onPick}
        />
      )}

      <div className="mt-3.5 flex gap-3">
        <Button variant="outline" onClick={onBack}>
          Back
        </Button>
        {empty ? null : (
          <Button
            className="flex-1"
            disabled={state.pick === null}
            onClick={onContinue}
          >
            Continue
          </Button>
        )}
      </div>
    </div>
  );
}
