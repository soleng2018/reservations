"use server";

import { headers } from "next/headers";
import { z } from "zod";
import { BookInput, type BookErrorCode } from "@/lib/booking-input";
import { fieldErrors, type FieldErrors } from "@/lib/form-errors";
import { authentik } from "@/server/authentik/client";
import { startsFor } from "@/server/booking/availability";
import {
  bookAsGuest,
  type GuestBookingError,
} from "@/server/booking/guest-booking";
import { db } from "@/server/db";
import { countAttempt } from "@/server/rate-limit";
import { clientIp } from "@/server/request-ip";
import { verifyTurnstile } from "@/server/turnstile";

// The public guest booking actions (spec 0004 AC-3 to AC-10). Public by
// design, so they call no require* (allow list in
// tests/server-actions-require.test.ts); Turnstile and rate limits guard them.

const STARTS_PER_IP = { limit: 60, windowSeconds: 600 } as const;
const BOOK_PER_IP = { limit: 5, windowSeconds: 600 } as const;
const BOOK_PER_EMAIL = { limit: 3, windowSeconds: 3600 } as const;

export type StartsResult =
  | { readonly starts: readonly string[] } // ISO UTC instants
  | { readonly limited: true };

// AC-3: only ISO times, never testbed names or other bookings.
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
  if (!id.success) return { starts: [] };
  const starts = await startsFor(conn, id.data);
  return { starts: starts.map((d) => d.toISOString()) };
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
