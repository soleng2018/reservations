import "server-only";
import type { Kysely } from "kysely";
import { z } from "zod";
import { dbNow } from "@/server/db/bookings";
import type { DB } from "@/server/db/types";

// Spec 0021 AC-2, AC-3, AC-8: a Current booking that ends early queues one
// cleanup_notify job in the same transaction as the cancel or move, so the
// job exists if and only if the change commits. The hook is never called
// here; the worker sends (server/jobs/cleanup-hook.ts). The payload holds
// ids and times only: no URL, secret, name, or email.

export const CleanupEvent = z.enum(["booking.ended_early", "booking.moved"]);
export type CleanupEvent = z.infer<typeof CleanupEvent>;

export const cleanupPayload = z.object({
  bookingId: z.uuid(),
  event: CleanupEvent,
  oldTestbedId: z.uuid(),
  oldStartsAt: z.iso.datetime(),
  oldEndsAt: z.iso.datetime(),
  occurredAt: z.iso.datetime(),
});
export type CleanupPayload = z.infer<typeof cleanupPayload>;

export const cleanupJobKey = (bookingId: string, version: number) =>
  `cleanup:${bookingId}:${version}`;

export type CleanupNotice = {
  readonly bookingId: string;
  // The booking's version after the change.
  readonly version: number;
  readonly event: CleanupEvent;
  readonly oldTestbedId: string;
  readonly oldStartsAt: Date;
  readonly oldEndsAt: Date;
};

export async function queueCleanupNotice(
  trx: Kysely<DB>,
  n: CleanupNotice,
): Promise<void> {
  const payload: CleanupPayload = {
    bookingId: n.bookingId,
    event: n.event,
    oldTestbedId: n.oldTestbedId,
    oldStartsAt: n.oldStartsAt.toISOString(),
    oldEndsAt: n.oldEndsAt.toISOString(),
    occurredAt: (await dbNow(trx)).toISOString(),
  };
  await trx
    .insertInto("jobs")
    .values({
      kind: "cleanup_notify",
      payload: JSON.stringify(payload),
      idempotency_key: cleanupJobKey(n.bookingId, n.version),
    })
    .onConflict((oc) => oc.column("idempotency_key").doNothing())
    .execute();
}
