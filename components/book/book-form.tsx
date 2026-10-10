"use client";

import Link from "next/link";
import {
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
  type FormEvent,
} from "react";
import {
  bookAction,
  loadStartsAction,
  type BookState,
} from "@/app/book/actions";
import { Field } from "@/components/field";
import { FormSelect, type SelectOption } from "@/components/form-select";
import { resetTurnstile, Turnstile } from "@/components/turnstile";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { BOOK_ERRORS } from "@/lib/booking-input";
import { formatTime, groupByDay } from "@/lib/format-time";
import { browserTimeZone, timezoneOptions } from "@/lib/timezones";
import { BookingConfirmation } from "./booking-confirmation";

const VISIBLE_DAYS = 7;
const STARTS_ERROR_ID = "book-startsAt-error";
const IDLE: BookState = { kind: "idle" };

type Starts =
  | { readonly kind: "none" }
  | { readonly kind: "loading" }
  | { readonly kind: "limited" }
  | { readonly kind: "ready"; readonly starts: readonly string[] };

// The browser's zone never changes while the page is open; the server
// snapshot is null, so the first render matches the server HTML.
const noSubscribe = () => () => {};

// The Step 1 form (spec 0004 AC-3 to AC-9), then the confirmation (AC-6).
export function BookForm({
  types,
  siteKey,
}: {
  readonly types: readonly SelectOption[];
  readonly siteKey: string;
}) {
  const [state, setState] = useState<BookState>(IDLE);
  const [pending, startTransition] = useTransition();

  const detected = useSyncExternalStore(
    noSubscribe,
    browserTimeZone,
    () => null,
  );
  const [chosenZone, setChosenZone] = useState<string | null>(null);
  const timezone = chosenZone ?? detected ?? "UTC";
  const zones = useMemo(
    () =>
      timezoneOptions(detected ?? "UTC").map((z) => ({
        value: z,
        label: z.replaceAll("_", " "),
      })),
    [detected],
  );

  const [typeId, setTypeId] = useState<string | null>(null);
  const [starts, setStarts] = useState<Starts>({ kind: "none" });
  const [startsAt, setStartsAt] = useState<string | null>(null);
  const [allDays, setAllDays] = useState(false);
  // Only the newest request may fill the list.
  const latest = useRef<string | null>(null);

  const reload = async (id: string) => {
    latest.current = id;
    setStarts({ kind: "loading" });
    const result = await loadStartsAction(id).catch(() => ({
      limited: true as const,
    }));
    if (latest.current !== id) return;
    setStarts(
      "limited" in result
        ? { kind: "limited" }
        : { kind: "ready", starts: result.starts },
    );
  };

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    startTransition(async () => {
      const next = await bookAction(state, data);
      setState(next);
      if (next.kind !== "error") return;
      resetTurnstile();
      // AC-7: keep what they typed, and reload the list without that time.
      if (next.code === "slot_taken" && typeId) {
        setStartsAt(null);
        await reload(typeId);
      }
    });
  };

  if (state.kind === "booked") return <BookingConfirmation booking={state} />;

  const fields = state.kind === "error" ? state.fields : {};
  const days =
    starts.kind === "ready"
      ? groupByDay(
          starts.starts.map((s) => new Date(s)),
          timezone,
        )
      : [];
  const shownDays = allDays ? days : days.slice(0, VISIBLE_DAYS);

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-6" noValidate>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field path="name" label="Name" error={fields.name}>
          <Input name="name" autoComplete="name" required maxLength={200} />
        </Field>
        <Field path="company" label="Company" error={fields.company}>
          <Input
            name="company"
            autoComplete="organization"
            required
            maxLength={200}
          />
        </Field>
        <Field path="email" label="Email" error={fields.email}>
          <Input
            name="email"
            type="email"
            autoComplete="email"
            required
            maxLength={254}
          />
        </Field>
        <Field path="timezone" label="Timezone" error={fields.timezone}>
          <FormSelect
            name="timezone"
            options={zones}
            placeholder="Choose a timezone"
            value={timezone}
            onValueChange={setChosenZone}
          />
        </Field>
        <Field
          path="testbedTypeId"
          label="Lab type"
          error={fields.testbedTypeId}
        >
          <FormSelect
            name="testbedTypeId"
            options={types}
            placeholder="Choose a lab type"
            value={typeId}
            onValueChange={(id) => {
              setTypeId(id);
              setStartsAt(null);
              setAllDays(false);
              void reload(id);
            }}
          />
        </Field>
      </div>

      <fieldset
        className="flex flex-col gap-4"
        aria-describedby={fields.startsAt ? STARTS_ERROR_ID : undefined}
      >
        <legend className="mb-2 text-sm font-medium">Start time</legend>
        {starts.kind === "none" ? (
          <p className="text-sm text-muted-foreground">
            Choose a lab type to see the free times.
          </p>
        ) : starts.kind === "loading" ? (
          <p className="text-sm text-muted-foreground" role="status">
            Loading free times…
          </p>
        ) : starts.kind === "limited" ? (
          <p className="text-sm text-destructive" role="status">
            {BOOK_ERRORS.limited}
          </p>
        ) : days.length === 0 ? (
          <p className="text-sm text-muted-foreground" role="status">
            No free times in the next 14 days.
          </p>
        ) : (
          <>
            {shownDays.map((day) => (
              <div key={day.key} className="flex flex-col gap-2">
                <h3 className="text-sm font-medium text-muted-foreground">
                  {day.label}
                </h3>
                <div className="flex flex-wrap gap-2">
                  {day.starts.map((start) => {
                    const iso = start.toISOString();
                    return (
                      <label key={iso} className="cursor-pointer">
                        <input
                          type="radio"
                          name="startsAt"
                          value={iso}
                          checked={startsAt === iso}
                          onChange={() => setStartsAt(iso)}
                          className="peer sr-only"
                        />
                        <span className="inline-flex h-8 items-center rounded-lg border px-3 text-sm peer-checked:border-primary peer-checked:bg-primary peer-checked:text-primary-foreground peer-focus-visible:ring-3 peer-focus-visible:ring-ring/50 hover:bg-muted">
                          {formatTime(start, timezone)}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            ))}
            {!allDays && days.length > VISIBLE_DAYS ? (
              <Button
                type="button"
                variant="outline"
                className="self-start"
                onClick={() => setAllDays(true)}
              >
                Show more days
              </Button>
            ) : null}
          </>
        )}
        {fields.startsAt ? (
          <p id={STARTS_ERROR_ID} className="text-sm text-destructive">
            {fields.startsAt}
          </p>
        ) : null}
      </fieldset>

      <Turnstile siteKey={siteKey} />

      {state.kind === "error" ? (
        <p role="alert" className="text-sm text-destructive">
          {BOOK_ERRORS[state.code]}
          {state.code === "has_live_booking" ? (
            <>
              {" "}
              <Link href="/reservations" className="font-medium underline">
                Manage your reservation
              </Link>
            </>
          ) : null}
        </p>
      ) : null}

      <Button
        type="submit"
        disabled={pending || !startsAt}
        className="self-start"
      >
        {pending ? "Booking…" : "Confirm booking"}
      </Button>
    </form>
  );
}
