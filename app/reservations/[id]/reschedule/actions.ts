"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { RescheduleErrorCode } from "@/lib/booking-input";
import { requireLearner } from "@/server/auth/require";
import { firstFreeTestbed, startsFor } from "@/server/booking/availability";
import {
  ownReschedulable,
  rescheduleOwnBooking,
} from "@/server/booking/manage";
import { db } from "@/server/db";
import { countAttempt } from "@/server/rate-limit";

// A learner's reschedule (spec 0011 AC-7 to AC-9, AC-14, AC-15). Every action
// calls requireLearner() first and reads only the session learner's own
// booking, so a guessed id answers `gone` or `stale`, never data.

// AC-14: per user buckets, every attempt counted.
const STARTS_PER_USER = { limit: 60, windowSeconds: 600 } as const;
const PREVIEW_PER_USER = { limit: 60, windowSeconds: 600 } as const;
const RESCHEDULE_PER_USER = { limit: 20, windowSeconds: 3600 } as const;

export type RescheduleStartsResult =
  | {
      readonly starts: readonly string[]; // ISO UTC instants
      readonly durationMs: number;
      readonly now: string; // DB now(), ISO
    }
  | { readonly limited: true }
  | { readonly gone: true };

// AC-7: the type's free starts, where this booking's own range never counts
// as busy. `gone` when the booking is no longer the learner's live,
// reschedulable one.
export async function loadRescheduleStartsAction(
  bookingId: string,
): Promise<RescheduleStartsResult> {
  const { user } = await requireLearner();
  const conn = db();
  const allowed = await countAttempt(
    conn,
    `reschedule-starts:user:${user.id}`,
    STARTS_PER_USER.limit,
    STARTS_PER_USER.windowSeconds,
  );
  if (!allowed) return { limited: true };
  const own = await ownReschedulable(conn, user.id, bookingId);
  if (own.kind !== "ok") return { gone: true };
  const { starts, durationMs, now } = await startsFor(
    conn,
    own.booking.typeId,
    { excludeBookingId: own.booking.id },
  );
  return {
    starts: starts.map((d) => d.toISOString()),
    durationMs,
    now: now.toISOString(),
  };
}

export type ReschedulePreviewResult =
  | {
      readonly kind: "ok";
      readonly testbedName: string;
      readonly endsAt: string; // ISO
    }
  | { readonly kind: "taken" }
  | { readonly kind: "limited" }
  | { readonly kind: "gone" };

const IsoStart = z.iso.datetime().transform((s) => new Date(s));

// AC-8: the testbed the move would likely get, keeping its own when free.
// Advice only; it holds nothing. A bad start reads as taken.
export async function previewRescheduleAction(
  bookingId: string,
  startsAt: string,
): Promise<ReschedulePreviewResult> {
  const { user } = await requireLearner();
  const conn = db();
  const allowed = await countAttempt(
    conn,
    `reschedule-preview:user:${user.id}`,
    PREVIEW_PER_USER.limit,
    PREVIEW_PER_USER.windowSeconds,
  );
  if (!allowed) return { kind: "limited" };
  const own = await ownReschedulable(conn, user.id, bookingId);
  if (own.kind !== "ok") return { kind: "gone" };
  const at = IsoStart.safeParse(startsAt);
  if (!at.success) return { kind: "taken" };
  const free = await firstFreeTestbed(conn, own.booking.typeId, at.data, {
    excludeBookingId: own.booking.id,
    preferTestbedId: own.booking.testbedId,
  });
  return free
    ? {
        kind: "ok",
        testbedName: free.testbedName,
        endsAt: free.endsAt.toISOString(),
      }
    : { kind: "taken" };
}

export type RescheduleResult =
  | {
      readonly kind: "rescheduled";
      readonly testbedName: string;
      readonly typeName: string;
      readonly startsAt: string; // ISO
      readonly endsAt: string; // ISO
    }
  | { readonly kind: "error"; readonly code: RescheduleErrorCode };

const RescheduleInput = z.object({
  bookingId: z.uuid(),
  version: z.number().int().positive(),
  startsAt: IsoStart,
});

const failed = (code: RescheduleErrorCode): RescheduleResult => ({
  kind: "error",
  code,
});

// AC-9: the bucket, then the input, then one locked transaction that either
// moves the booking or leaves it untouched.
export async function rescheduleAction(
  bookingId: string,
  version: number,
  startsAt: string,
): Promise<RescheduleResult> {
  const { user } = await requireLearner();
  const conn = db();
  const allowed = await countAttempt(
    conn,
    `reschedule:user:${user.id}`,
    RESCHEDULE_PER_USER.limit,
    RESCHEDULE_PER_USER.windowSeconds,
  );
  if (!allowed) return failed("limited");
  const input = RescheduleInput.safeParse({ bookingId, version, startsAt });
  if (!input.success) return failed("invalid");

  const moved = await rescheduleOwnBooking(conn, user.id, input.data);
  revalidatePath("/reservations");
  if (!moved.ok) return failed(moved.error);
  return {
    kind: "rescheduled",
    testbedName: moved.value.testbedName,
    typeName: moved.value.typeName,
    startsAt: moved.value.startsAt.toISOString(),
    endsAt: moved.value.endsAt.toISOString(),
  };
}
