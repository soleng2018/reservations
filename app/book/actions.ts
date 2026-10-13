"use server";

import { headers } from "next/headers";
import { z } from "zod";
import {
  AS_ACCOUNT,
  BookInput,
  DetailsInput,
  type BookErrorCode,
  type DetailsErrorCode,
} from "@/lib/booking-input";
import { fieldErrors, type FieldErrors } from "@/lib/form-errors";
import { err, ok, type Result } from "@/lib/result";
import { authentik } from "@/server/authentik/client";
import { sessionAccount, type LearnerAccount } from "@/server/booking/account";
import { firstFreeTestbed, startsFor } from "@/server/booking/availability";
import { checkGuestDetails } from "@/server/booking/details-check";
import {
  bookAsGuest,
  type GuestBookingError,
} from "@/server/booking/guest-booking";
import { dbNow } from "@/server/db/bookings";
import { db } from "@/server/db";
import type { GuestBookingInput } from "@/server/db/guest-saga";
import { countAttempt } from "@/server/rate-limit";
import { clientIp } from "@/server/request-ip";
import { verifyTurnstile } from "@/server/turnstile";

// The public guest booking actions (spec 0004 AC-3 to AC-10, spec 0010 AC-2,
// AC-4, AC-7). Public by design, so they call no require* (allow list in
// tests/server-actions-require.test.ts); Turnstile and rate limits guard them.
// None of them returns another learner's data. An active learner signed in
// books as themselves (spec 0011 AC-13): Step 1 and confirm take the name,
// company, email, and zone from their users row as stored, never the form,
// so a crafted post cannot book under another email.

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

// The only fields a signed in learner sends (spec 0011 AC-13).
const AccountDetailsInput = DetailsInput.pick({ testbedTypeId: true });
const AccountBookInput = BookInput.pick({
  testbedTypeId: true,
  startsAt: true,
});

const asObject = (input: unknown) =>
  typeof input === "object" && input !== null ? input : {};

// What a Step 1 check runs on: a signed in learner's own email and the type
// they picked, else the guest's fields.
function detailsFor(
  account: LearnerAccount | undefined,
  input: unknown,
): Result<
  { readonly email: string; readonly testbedTypeId: string },
  FieldErrors
> {
  if (account) {
    const picked = AccountDetailsInput.safeParse(asObject(input));
    return picked.success
      ? ok({ email: account.email, testbedTypeId: picked.data.testbedTypeId })
      : err(fieldErrors(picked.error));
  }
  const parsed = DetailsInput.safeParse(asObject(input));
  return parsed.success ? ok(parsed.data) : err(fieldErrors(parsed.error));
}

// spec 0010 AC-2: the Step 1 check. Writes nothing but rate limit rows and
// no audit row. `asAccount` is "1" when the flow showed the account summary.
export async function checkDetailsAction(
  input: DetailsFields,
  asAccount?: string,
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

  // A post made as the account with no active learner behind it never
  // checks as a guest.
  const account = await sessionAccount(conn);
  if (asAccount === AS_ACCOUNT && !account) return refuse("signed_out");

  // (2) the fields. A non object input parses as all fields missing.
  const parsed = detailsFor(account, input);
  if (!parsed.ok) return refuse("invalid", parsed.error);

  // (3) the email bucket fails open: over it, answer ok and read nothing, so
  // nobody can lock a guest out of Step 1 (confirm still checks).
  const emailAllowed = await countAttempt(
    conn,
    `details:email:${parsed.value.email.toLowerCase()}`,
    DETAILS_PER_EMAIL.limit,
    DETAILS_PER_EMAIL.windowSeconds,
  );
  if (!emailAllowed) return { kind: "ok" };

  // (4) the reads.
  const checked = await checkGuestDetails(conn, parsed.value);
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

// What a confirm books: a signed in learner's stored account with the type
// and start they picked, else the guest's form.
function bookingFor(
  account: LearnerAccount | undefined,
  form: FormData,
): Result<GuestBookingInput, FieldErrors> {
  const picked = {
    testbedTypeId: text(form, "testbedTypeId"),
    startsAt: text(form, "startsAt"),
  };
  if (account) {
    const parsed = AccountBookInput.safeParse(picked);
    return parsed.success
      ? ok({
          name: account.name,
          company: account.company ?? "",
          email: account.email,
          timezone: account.timezone,
          ...parsed.data,
        })
      : err(fieldErrors(parsed.error));
  }
  const parsed = BookInput.safeParse({
    name: text(form, "name"),
    company: text(form, "company"),
    email: text(form, "email"),
    timezone: text(form, "timezone"),
    ...picked,
  });
  return parsed.success ? ok(parsed.data) : err(fieldErrors(parsed.error));
}

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

  // A post made as the account with no active learner behind it never
  // books as a guest (spec 0011 AC-13).
  const account = await sessionAccount(conn);
  if (text(form, "asAccount") === AS_ACCOUNT && !account)
    return failed("signed_out");

  // (2) Turnstile, failing closed when Cloudflare is unreachable.
  const human = await verifyTurnstile(
    text(form, "cf-turnstile-response") ?? "",
    ip === "untrusted" ? undefined : ip,
  );
  if (!human.ok) return failed("limited");

  // (3) the form, or the account and the form's type and start.
  const parsed = bookingFor(account, form);
  if (!parsed.ok) return failed("invalid", parsed.error);
  const input = parsed.value;

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
