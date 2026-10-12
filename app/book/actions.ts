"use server";

import { headers } from "next/headers";
import { z } from "zod";
import {
  BookInput,
  DetailsInput,
  type BookErrorCode,
  type DetailsErrorCode,
} from "@/lib/booking-input";
import { fieldErrors, type FieldErrors } from "@/lib/form-errors";
import { authentik } from "@/server/authentik/client";
import { firstFreeTestbed, startsFor } from "@/server/booking/availability";
import { checkGuestDetails } from "@/server/booking/details-check";
import {
  bookAsGuest,
  type GuestBookingError,
} from "@/server/booking/guest-booking";
import { dbNow } from "@/server/db/bookings";
import { db } from "@/server/db";
import { countAttempt } from "@/server/rate-limit";
import { clientIp } from "@/server/request-ip";
import { verifyTurnstile } from "@/server/turnstile";

// The public guest booking actions (spec 0004 AC-3 to AC-10, spec 0010 AC-2,
// AC-4, AC-7). Public by design, so they call no require* (allow list in
// tests/server-actions-require.test.ts); Turnstile and rate limits guard them.
// None of them returns another learner's data.

const DETAILS_PER_IP = { limit: 20, windowSeconds: 600 } as const;
const DETAILS_PER_EMAIL = { limit: 10, windowSeconds: 3600 } as const;
const STARTS_PER_IP = { limit: 60, windowSeconds: 600 } as const;
const PREVIEW_PER_IP = { limit: 60, windowSeconds: 600 } as const;
const BOOK_PER_IP = { limit: 5, windowSeconds: 600 } as const;
const BOOK_PER_EMAIL = { limit: 3, windowSeconds: 3600 } as const;

export type DetailsResult =
  | { readonly kind: "ok" }
  | {
      readonly kind: "error";
      readonly code: DetailsErrorCode;
      readonly fields: FieldErrors; // empty except for "invalid"
    };

export type DetailsFields = Readonly<Record<keyof DetailsInput, string>>;

// spec 0010 AC-2: the Step 1 check. Writes nothing but rate limit rows and
// no audit row.
export async function checkDetailsAction(
  input: DetailsFields,
): Promise<DetailsResult> {
  const conn = db();
  const ip = clientIp(await headers());
  const refuse = (code: DetailsErrorCode, fields: FieldErrors = {}) =>
    ({ kind: "error", code, fields }) as const;

  // (1) the IP bucket.
  const ipAllowed = await countAttempt(
    conn,
    `details:ip:${ip}`,
    DETAILS_PER_IP.limit,
    DETAILS_PER_IP.windowSeconds,
  );
  if (!ipAllowed) return refuse("limited");

  // (2) the fields. A non object input parses as all fields missing.
  const parsed = DetailsInput.safeParse(
    typeof input === "object" && input !== null ? input : {},
  );
  if (!parsed.success) return refuse("invalid", fieldErrors(parsed.error));

  // (3) the email bucket fails open: over it, answer ok and read nothing, so
  // nobody can lock a guest out of Step 1 (confirm still checks).
  const emailAllowed = await countAttempt(
    conn,
    `details:email:${parsed.data.email.toLowerCase()}`,
    DETAILS_PER_EMAIL.limit,
    DETAILS_PER_EMAIL.windowSeconds,
  );
  if (!emailAllowed) return { kind: "ok" };

  // (4) the reads.
  const checked = await checkGuestDetails(conn, parsed.data);
  return checked.ok ? { kind: "ok" } : refuse(checked.error);
}

export type StartsResult =
  | {
      readonly starts: readonly string[]; // ISO UTC instants
      readonly durationMs: number; // 0 for an unknown or unbookable type
      readonly now: string; // DB now(), ISO
    }
  | { readonly limited: true };

// spec 0004 AC-3, spec 0010 AC-4: only ISO times and the type's length,
// never testbed names or other bookings.
export async function loadStartsAction(
  testbedTypeId: string,
): Promise<StartsResult> {
  const conn = db();
  const ip = clientIp(await headers());
  const allowed = await countAttempt(
    conn,
    `starts:ip:${ip}`,
    STARTS_PER_IP.limit,
    STARTS_PER_IP.windowSeconds,
  );
  if (!allowed) return { limited: true };
  const id = z.uuid().safeParse(testbedTypeId);
  if (!id.success)
    return {
      starts: [],
      durationMs: 0,
      now: (await dbNow(conn)).toISOString(),
    };
  const { starts, durationMs, now } = await startsFor(conn, id.data);
  return {
    starts: starts.map((d) => d.toISOString()),
    durationMs,
    now: now.toISOString(),
  };
}

export type PreviewResult =
  | {
      readonly kind: "ok";
      readonly testbedName: string;
      readonly endsAt: string; // ISO
    }
  | { readonly kind: "taken" }
  | { readonly kind: "limited" };

const PreviewInput = z.object({
  testbedTypeId: z.uuid(),
  startsAt: z.iso.datetime().transform((s) => new Date(s)),
});

// spec 0010 AC-7: the testbed the guest would likely get. Advice only; it
// holds nothing, and the saga decides at confirm. Bad input reads as taken.
export async function previewTestbedAction(
  testbedTypeId: string,
  startsAt: string,
): Promise<PreviewResult> {
  const conn = db();
  const ip = clientIp(await headers());
  const allowed = await countAttempt(
    conn,
    `preview:ip:${ip}`,
    PREVIEW_PER_IP.limit,
    PREVIEW_PER_IP.windowSeconds,
  );
  if (!allowed) return { kind: "limited" };
  const input = PreviewInput.safeParse({ testbedTypeId, startsAt });
  if (!input.success) return { kind: "taken" };
  const free = await firstFreeTestbed(
    conn,
    input.data.testbedTypeId,
    input.data.startsAt,
  );
  return free
    ? {
        kind: "ok",
        testbedName: free.testbedName,
        endsAt: free.endsAt.toISOString(),
      }
    : { kind: "taken" };
}

export type BookState =
  | { readonly kind: "idle" }
  | {
      readonly kind: "booked";
      readonly typeName: string;
      readonly testbedName: string;
      readonly startsAt: string;
      readonly endsAt: string;
      readonly timezone: string;
      readonly newUser: boolean;
    }
  | {
      readonly kind: "error";
      readonly code: BookErrorCode;
      readonly fields: FieldErrors;
    };

const failed = (code: BookErrorCode, fields: FieldErrors = {}): BookState => ({
  kind: "error",
  code,
  fields,
});

const text = (form: FormData, key: string) => {
  const v = form.get(key);
  return typeof v === "string" ? v : undefined;
};

// A type that lost its last bookable testbed reads as a taken time: the
// start list then reloads (empty) for the guest.
const toCode = (error: GuestBookingError): BookErrorCode =>
  error === "not_bookable" ? "slot_taken" : error;

// AC-4: the checks run in this order, before any booking write, and every
// attempt that reaches a bucket counts.
export async function bookAction(
  _prev: BookState,
  form: FormData,
): Promise<BookState> {
  const conn = db();
  const ip = clientIp(await headers());

  // (1) the IP bucket, before Turnstile, so a failed challenge uses it up.
  const ipAllowed = await countAttempt(
    conn,
    `book:ip:${ip}`,
    BOOK_PER_IP.limit,
    BOOK_PER_IP.windowSeconds,
  );
  if (!ipAllowed) return failed("limited");

  // (2) Turnstile, failing closed when Cloudflare is unreachable.
  const human = await verifyTurnstile(
    text(form, "cf-turnstile-response") ?? "",
    ip === "untrusted" ? undefined : ip,
  );
  if (!human.ok) return failed("limited");

  // (3) the form.
  const parsed = BookInput.safeParse({
    name: text(form, "name"),
    company: text(form, "company"),
    email: text(form, "email"),
    timezone: text(form, "timezone"),
    testbedTypeId: text(form, "testbedTypeId"),
    startsAt: text(form, "startsAt"),
  });
  if (!parsed.success) return failed("invalid", fieldErrors(parsed.error));
  const input = parsed.data;

  // (4) the email bucket, keyed only once the email parses.
  const emailAllowed = await countAttempt(
    conn,
    `book:email:${input.email.toLowerCase()}`,
    BOOK_PER_EMAIL.limit,
    BOOK_PER_EMAIL.windowSeconds,
  );
  if (!emailAllowed) return failed("limited");

  const booked = await bookAsGuest(authentik(), conn, input);
  if (!booked.ok) return failed(toCode(booked.error));
  return {
    kind: "booked",
    typeName: booked.value.typeName,
    testbedName: booked.value.testbedName,
    startsAt: input.startsAt.toISOString(),
    endsAt: booked.value.endsAt.toISOString(),
    timezone: input.timezone,
    newUser: booked.value.newUser,
  };
}
