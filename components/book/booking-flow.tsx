"use client";

import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { AlertCircleIcon, RotateCwIcon } from "lucide-react";
import {
  bookAction,
  checkDetailsAction,
  loadStartsAction,
  previewTestbedAction,
  type DetailsFields,
} from "@/app/book/actions";
import { Turnstile } from "@/components/turnstile";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import {
  flowReducer,
  historyPos,
  initialFlow,
  screenOf,
  STEP_INDEX,
  stepFromParam,
  stepUrl,
  type Account,
  type FlowEvent,
  type FlowState,
} from "@/lib/booking-flow";
import { AS_ACCOUNT, BOOK_ERRORS } from "@/lib/booking-input";
import { formatDateTime } from "@/lib/format-time";
import { browserTimeZone, timezoneOptions, zoneLabel } from "@/lib/timezones";
import { cn } from "@/lib/utils";
import { BookingSuccess } from "./booking-success";
import { ConfirmStep, type ConfirmSummary } from "./confirm-step";
import { DetailsStep } from "./details-step";
import { FailureScreen } from "./failure-screen";
import { ProgressScreen } from "./progress-screen";
import { BOOK_HEADING_ID, StepHeading } from "./step-heading";
import { TimeStep } from "./time-step";

export type BookType = {
  readonly id: string;
  readonly name: string;
  readonly duration: string; // "4 hours"
};

const STALE_AFTER_MS = 5 * 60_000; // AC-6: a refocus reloads an older list
const TICKS_AT_MS = [750, 1500] as const; // AC-8
const SUCCESS_AFTER_MS = 400;

// The browser's zone never changes while the page is open; the server
// snapshot is null, so the first render matches the server HTML.
const noSubscribe = () => () => {};

const urlStep = () =>
  stepFromParam(new URLSearchParams(window.location.search).get("step"));

// The /book flow (spec 0010): details, time, confirm, then progress and a
// success or failure screen. The flow's state lives in memory only, never
// in the URL, storage, or a cookie; the URL carries just the step. With an
// `account` (spec 0011 AC-13) the details come from it and every post says
// so (`asAccount`), so a lost session is told apart from a guest.
export function BookingFlow({
  types,
  siteKey,
  account,
}: {
  readonly types: readonly BookType[];
  readonly siteKey: string;
  readonly account?: Account;
}) {
  const router = useRouter();
  const detected = useSyncExternalStore(
    noSubscribe,
    browserTimeZone,
    () => null,
  );
  const zones = useMemo(
    () => (detected === null ? [] : timezoneOptions(detected)),
    [detected],
  );

  const [state, setState] = useState<FlowState>(() => initialFlow("", account));
  // The latest state for event handlers, kept in step with every send.
  const latest = useRef(state);
  // Popstates caused by our own history.go(), which the flow already shows.
  const selfNav = useRef(0);

  const send = useCallback((event: FlowEvent, syncUrl = true) => {
    const prev = latest.current;
    const next = flowReducer(prev, event);
    if (next === prev) return;
    latest.current = next;
    setState(next);
    if (!syncUrl) return;
    if (next.phase === "success" && prev.phase !== "success") {
      window.history.replaceState(null, "", "/book");
      return;
    }
    if (next.phase !== "editing") return;
    const delta = historyPos(next) - historyPos(prev);
    if (delta > 0) window.history.pushState(null, "", stepUrl(next.step));
    if (delta < 0) {
      selfNav.current += 1;
      window.history.go(delta);
    }
  }, []);

  // AC-11: on load there are no details in memory, so a Step 2 or 3 URL
  // (a refresh, a deep link, a new tab) falls back to an empty Step 1.
  useEffect(() => {
    if (urlStep() !== "details") window.history.replaceState(null, "", "/book");
  }, []);

  // Browser Back and Forward move between steps while editing; progress,
  // failure, and success ignore them and return to their own entry.
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
      // A step it may not open (no details, or no pick): back to the one
      // it shows.
      const shown = historyPos(latest.current);
      if (shown !== at) {
        selfNav.current += 1;
        window.history.go(shown - at);
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [send]);

  const screen = screenOf(state);
  const timezone =
    state.details?.timezone ?? (state.form.timezone || detected || "UTC");
  const typeId = state.details?.testbedTypeId ?? null;
  const type = types.find((t) => t.id === typeId) ?? null;

  // AC-6: the starts load on entering Step 2 (after a slot_taken result
  // too), and only while no submit runs.
  const loadStarts = useCallback(
    async (id: string) => {
      send({ type: "starts_loading" });
      const result = await loadStartsAction(id).catch(() => "thrown" as const);
      if (latest.current.details?.testbedTypeId !== id) return;
      send({ type: "starts_done", result, at: Date.now() });
    },
    [send],
  );

  useEffect(() => {
    if (screen === "time" && typeId) void loadStarts(typeId);
  }, [screen, typeId, loadStarts]);

  // AC-6: back on the tab with a list older than 5 minutes, Step 2 only.
  useEffect(() => {
    if (screen !== "time" || !typeId) return;
    const onVisible = () => {
      const s = latest.current;
      if (
        document.visibilityState === "visible" &&
        s.startsStatus !== "loading" &&
        s.starts !== null &&
        Date.now() - s.starts.loadedAt > STALE_AFTER_MS
      )
        void loadStarts(typeId);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [screen, typeId, loadStarts]);

  // AC-7: each entry to Step 3 previews the testbed.
  const pick = state.pick;
  const previewing = screen === "confirm" && state.preview.kind === "loading";
  useEffect(() => {
    if (!previewing || !typeId || !pick) return;
    let live = true;
    previewTestbedAction(typeId, pick)
      .catch(() => "thrown" as const)
      .then((result) => {
        if (live) send({ type: "preview_done", result });
      });
    return () => {
      live = false;
    };
  }, [previewing, typeId, pick, send]);

  // A new screen's title takes focus (not on the first render). Compares
  // against the screen last shown, so the effect running twice on one mount
  // (StrictMode in dev) never steals focus on load.
  const shownScreen = useRef(screen);
  useEffect(() => {
    if (screen === shownScreen.current) return;
    shownScreen.current = screen;
    document.getElementById(BOOK_HEADING_ID)?.focus();
  }, [screen]);

  // AC-3: field errors move focus to the first invalid field.
  useEffect(() => {
    if (Object.keys(state.fields).length === 0) return;
    document
      .querySelector<HTMLElement>('[data-field][aria-invalid="true"]')
      ?.focus();
  }, [state.fields]);

  const onContinueDetails = async () => {
    const s = latest.current;
    if (s.checking) return;
    const form: DetailsFields = { ...s.form, timezone };
    send({ type: "check_started", form });
    const result = await checkDetailsAction(
      form,
      account ? AS_ACCOUNT : undefined,
    ).catch(() => "thrown" as const);
    // AC-3: a type gone meanwhile refreshes the list from the server.
    if (
      result !== "thrown" &&
      result.kind === "error" &&
      result.code === "type_unavailable"
    )
      router.refresh();
    send({ type: "check_done", form, result });
  };

  const onToken = useCallback(
    (token: string | null) => send({ type: "token", token }),
    [send],
  );

  // AC-8, AC-9: one submit at a time; only the latest submit's reply counts.
  const submit = async () => {
    const s = latest.current;
    if (!s.details || !s.pick || !s.token || s.phase === "progress") return;
    const id = s.submitId + 1;
    const form = new FormData();
    Object.entries(s.details).forEach(([k, v]) => form.set(k, v));
    form.set("startsAt", s.pick);
    form.set("cf-turnstile-response", s.token);
    if (account) form.set("asAccount", AS_ACCOUNT);
    send({ type: "submit", id });
    const timers = TICKS_AT_MS.map((ms, i) =>
      setTimeout(() => send({ type: "tick", id, ticks: i + 1 }), ms),
    );
    const result = await bookAction({ kind: "idle" }, form).catch(
      () => "thrown" as const,
    );
    timers.forEach(clearTimeout);
    send({ type: "book_done", id, result });
    if (result !== "thrown" && result.kind === "booked")
      setTimeout(() => send({ type: "show_success", id }), SUCCESS_AFTER_MS);
  };

  if (screen === "details")
    return (
      <DetailsStep
        types={types.map((t) => ({
          value: t.id,
          label: `${t.name} · ${t.duration}`,
        }))}
        zones={zones}
        account={account}
        form={{ ...state.form, timezone }}
        fields={state.fields}
        notice={state.notice}
        checking={state.checking}
        onEdit={(field, value) => send({ type: "edit", field, value })}
        onContinue={() => void onContinueDetails()}
      />
    );

  if (screen === "success" && state.booked && state.success)
    return (
      <BookingSuccess
        booking={state.booked}
        firstName={state.success.firstName}
        email={state.success.email}
        signedIn={account !== undefined}
      />
    );

  if (screen === "time")
    return (
      <TimeScreen
        state={state}
        type={type}
        timezone={timezone}
        onPickDay={(key) => send({ type: "pick_day", key })}
        onPick={(iso) => send({ type: "pick_start", iso })}
        onRetry={() => typeId && void loadStarts(typeId)}
        onBack={() => send({ type: "go", step: "details" })}
        onContinue={() => send({ type: "go", step: "confirm" })}
      />
    );

  // Step 3, progress, and failure share one container, so the Turnstile
  // widget stays mounted across them (AC-7): seen on Step 3 and failure,
  // hidden during progress.
  const durationMs = state.starts?.durationMs ?? 0;
  const startsAt = pick ? new Date(pick) : null;
  const endsAt =
    state.preview.kind === "ok"
      ? new Date(state.preview.endsAt)
      : startsAt && new Date(startsAt.getTime() + durationMs);
  const summary: ConfirmSummary = {
    eyebrow: "Step 3 of 3",
    title: "Confirm your reservation",
    who: [
      { label: "Name", value: state.details?.name.trim() ?? "" },
      // A signed in learner's stored company may be unset (AC-13).
      ...(account?.company === null
        ? []
        : [{ label: "Company", value: state.details?.company.trim() ?? "" }]),
      { label: "Email", value: state.details?.email.trim() ?? "" },
      { label: "Lab type", value: type?.name ?? "" },
      {
        label: "Timezone",
        value: zoneLabel(timezone, startsAt ?? new Date()),
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
        <ConfirmStep summary={summary} />
      ) : screen === "progress" ? (
        <ProgressScreen ticks={state.ticks} />
      ) : (
        <FailureScreen failure={state.failure ?? "unknown"} />
      )}

      <div
        className={
          screen === "progress"
            ? "hidden"
            : "mt-5 flex min-h-16.25 justify-center"
        }
      >
        <Turnstile
          siteKey={siteKey}
          onToken={onToken}
          resetSignal={state.resetSignal}
        />
      </div>

      {screen === "confirm" ? (
        <>
          {state.confirmLimited ? (
            <Alert variant="destructive" className="mt-4">
              <AlertCircleIcon aria-hidden="true" />
              <AlertDescription>{BOOK_ERRORS.limited}</AlertDescription>
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
              disabled={!state.token || running}
              onClick={() => void submit()}
            >
              Confirm reservation
            </Button>
          </div>
        </>
      ) : screen === "failure" ? (
        <div className="mt-7 flex justify-center gap-3">
          <Button
            variant="outline"
            size="lg"
            onClick={() => send({ type: "failure_back" })}
          >
            Back
          </Button>
          <Button
            size="lg"
            disabled={!state.token}
            onClick={() => void submit()}
          >
            {state.token ? null : <Spinner data-icon="inline-start" />}
            Try again
          </Button>
        </div>
      ) : null}
    </div>
  );
}

// Step 2 around the time picker (spec 0010 AC-4 to AC-6): the heading, the
// load states, the dropped pick message, and Back and Continue.
function TimeScreen({
  state,
  type,
  timezone,
  onPickDay,
  onPick,
  onRetry,
  onBack,
  onContinue,
}: {
  readonly state: FlowState;
  readonly type: BookType | null;
  readonly timezone: string;
  readonly onPickDay: (key: string) => void;
  readonly onPick: (iso: string) => void;
  readonly onRetry: () => void;
  readonly onBack: () => void;
  readonly onContinue: () => void;
}) {
  const list = state.starts;
  const empty = list !== null && list.starts.length === 0;
  return (
    <div className="mx-auto w-full max-w-130 px-5 pt-5.5 pb-6 md:max-w-235">
      <StepHeading
        compact
        eyebrow="Step 2 of 3"
        title="Choose a time"
        subtitle={type ? `${type.name} · ${type.duration}` : undefined}
      />

      {state.dropped ? (
        <Alert variant="destructive" className="mb-3.5">
          <AlertCircleIcon aria-hidden="true" />
          <AlertDescription>{BOOK_ERRORS.slot_taken}</AlertDescription>
        </Alert>
      ) : null}

      {state.startsStatus === "failed" ? (
        <Alert variant="destructive" className="mb-3.5">
          <AlertCircleIcon aria-hidden="true" />
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            <span>{BOOK_ERRORS.limited}</span>
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
          No free times in the next 90 days. Try another lab type.
        </p>
      ) : (
        <TimeStep
          starts={list.starts}
          durationMs={list.durationMs}
          durationLabel={type?.duration ?? ""}
          now={list.now}
          timezone={timezone}
          day={state.day}
          picked={state.pick}
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
