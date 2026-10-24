import { sql, type Kysely, type Transaction } from "kysely";
import { afterAll, describe, expect, it, vi } from "vitest";
import { SUPPRESSED_NO_DEV_INBOX } from "@/lib/email-routing";
import { ok } from "@/lib/result";
import { LEAD_MS, REMINDER_LEAD_MS } from "@/lib/slots";
import type { GoogleMailConfig } from "@/server/catalog/api-keys";
import { db } from "@/server/db";
import { dbNow } from "@/server/db/bookings";
import {
  asConn,
  hasDb,
  inRollback,
  makeTestbed,
  makeType,
  makeUser,
  slot,
} from "@/server/db/testing";
import type { DB, Json } from "@/server/db/types";
import { inviteOf } from "@/server/email/testing";
import { listUserEmails } from "@/server/email/messages";
import {
  fakeGoogleFetch,
  serviceAccountCredentials,
  type RecordedRequest,
} from "@/server/google/testing";
import type { MintToken } from "@/server/google/token";
import {
  emailJobKey,
  queueBookingNotice,
  reminderJobKey,
  type ShownAtBooking,
} from "./booking-notice";
import { queueReminders } from "./reminders";
import { claimJob, runJobs, type Handlers } from "./runner";
import {
  REMINDER_CHANGED,
  REMINDER_TOO_CLOSE,
  runSendEmail,
} from "./send-email";

// covers: spec 0015 AC-2 to AC-5, AC-8 to AC-12, AC-13, AC-14. Dev and prod
// share one database, so everything runs inside a rolled back transaction.
// The sweep takes a fixed `now` here, read from the DB clock, so the 24 hour
// and 1 hour edges can be hit exactly (bookings sit on a half hour grid).

const HOUR = 3_600_000;
const shift = (d: Date, ms: number) => new Date(d.getTime() + ms);

const config = (): GoogleMailConfig => ({
  id: crypto.randomUUID(),
  credentials: serviceAccountCredentials(),
  secretUpdatedAt: new Date("2026-10-15T00:00:00.000Z"),
  senderEmail: "labs@nile.example",
  calendarId: "c_abc@group.calendar.google.com",
  devInbox: "dev-inbox@nile.example",
  opsBcc: "ops@nile.example",
  stamp: crypto.randomUUID(),
});

const mint: MintToken = async () =>
  ok({ token: "token-1", expiresAt: Date.now() + HOUR });

const HANDLERS: Handlers = { send_email: runSendEmail };

const parkRealJobs = (trx: Kysely<DB>) =>
  trx
    .updateTable("jobs")
    .set({ status: "failed" })
    .where("status", "in", ["pending", "running"])
    .execute();

const SHOWN: ShownAtBooking = { timezone: "Asia/Kolkata", newAccount: true };

// A confirmed booking `startsIn` hours out (on the grid) with its booked
// email queued, made `noticeLead` before the start (48 hours by default).
async function bookingAt(
  trx: Transaction<DB>,
  opts: { startsIn?: number; noticeLead?: number; email?: string } = {},
) {
  const user = await makeUser(trx, {
    name: "Priya Raman",
    email: opts.email ?? `priya-${crypto.randomUUID().slice(0, 6)}@acme.com`,
    timezone: "America/New_York",
  });
  const type = await makeType(trx);
  const testbed = await makeTestbed(trx, type.id);
  await trx
    .insertInto("testbed_clients")
    .values({
      testbed_id: testbed.id,
      kind: "wireless",
      name: "Wireless client",
      url: "https://c.example.test/wl",
      position: 0,
    })
    .execute();
  const startsAt = slot(opts.startsIn ?? 72);
  const { id: bookingId } = await trx
    .insertInto("bookings")
    .values({
      user_id: user.id,
      testbed_id: testbed.id,
      testbed_type_id: type.id,
      starts_at: startsAt,
      ends_at: shift(startsAt, 2 * HOUR),
      status: "confirmed",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await queueBookingNotice(trx, bookingId, 1, "booked", SHOWN);
  await noticeMadeAt(
    trx,
    bookingId,
    1,
    shift(startsAt, -(opts.noticeLead ?? 48) * HOUR),
  );
  return { user, testbed, bookingId, startsAt };
}

const noticeMadeAt = (
  trx: Kysely<DB>,
  bookingId: string,
  version: number,
  at: Date,
) =>
  trx
    .updateTable("email_messages")
    .set({ created_at: at })
    .where("booking_id", "=", bookingId)
    .where("booking_version", "=", version)
    .where("kind", "in", ["booked", "rescheduled"])
    .execute();

// A reschedule as the app records it: the trigger bumps the version and
// the rescheduled email is queued, made `noticeLead` before the new start.
async function rescheduleTo(
  trx: Kysely<DB>,
  bookingId: string,
  startsAt: Date,
  noticeLead: number,
) {
  await trx
    .updateTable("bookings")
    .set({ starts_at: startsAt, ends_at: shift(startsAt, 2 * HOUR) })
    .where("id", "=", bookingId)
    .execute();
  await queueBookingNotice(trx, bookingId, 2, "rescheduled");
  await noticeMadeAt(trx, bookingId, 2, shift(startsAt, -noticeLead * HOUR));
}

const cancel = (trx: Kysely<DB>, bookingId: string) =>
  trx
    .updateTable("bookings")
    .set({
      status: "cancelled",
      cancelled_at: new Date(),
      cancel_source: "admin",
    })
    .where("id", "=", bookingId)
    .execute();

// Merges `patch` into a row's details snapshot.
const patched = (patch: Record<string, string>) =>
  sql<Json>`details || ${JSON.stringify(patch)}::jsonb`;

const remindersOf = (trx: Kysely<DB>, bookingId: string) =>
  trx
    .selectFrom("email_messages")
    .selectAll()
    .where("booking_id", "=", bookingId)
    .where("kind", "=", "reminder")
    .execute();

const sweepAt = (trx: Transaction<DB>, now: Date) =>
  queueReminders(asConn(trx), { now });

const decoded = (req: RecordedRequest) => {
  const { raw } = JSON.parse(req.body ?? "{}") as { raw: string };
  return Buffer.from(raw, "base64url").toString("utf8");
};

afterAll(() => (hasDb ? db().destroy() : undefined));

describe("reminderJobKey (AC-4)", () => {
  const id = "0b6f3c1e-2a4d-4f8e-9c7b-5d1a2e3f4a5b";

  it("is reminder:<booking id>:<version>", () => {
    expect(reminderJobKey(id, 3)).toBe(`reminder:${id}:3`);
  });

  it("never reads as a booking change's email key", () => {
    expect(reminderJobKey(id, 1)).not.toBe(emailJobKey(id, "booked", 1));
    expect(reminderJobKey(id, 1).startsWith("email:")).toBe(false);
  });
});

describe.skipIf(!hasDb)("queueReminders: when a reminder is due", () => {
  it("is due exactly at the 24 hour mark, and not a moment before (AC-2)", () =>
    inRollback(async (trx) => {
      const { bookingId, startsAt } = await bookingAt(trx);
      await sweepAt(trx, shift(startsAt, -REMINDER_LEAD_MS - 1));
      expect(await remindersOf(trx, bookingId)).toHaveLength(0);
      await sweepAt(trx, shift(startsAt, -REMINDER_LEAD_MS));
      expect(await remindersOf(trx, bookingId)).toHaveLength(1);
    }));

  it("is due exactly 1 hour out, and never later (AC-2, AC-12)", () =>
    inRollback(async (trx) => {
      const late = await bookingAt(trx);
      await sweepAt(trx, shift(late.startsAt, -LEAD_MS + 1));
      expect(await remindersOf(trx, late.bookingId)).toHaveLength(0);

      const edge = await bookingAt(trx, { startsIn: 96 });
      await sweepAt(trx, shift(edge.startsAt, -LEAD_MS));
      expect(await remindersOf(trx, edge.bookingId)).toHaveLength(1);
    }));

  it("catches up after an outage: 5 hours out gets one, 30 minutes out none (AC-12)", () =>
    inRollback(async (trx) => {
      const { bookingId, startsAt } = await bookingAt(trx);
      await sweepAt(trx, shift(startsAt, -0.5 * HOUR));
      expect(await remindersOf(trx, bookingId)).toHaveLength(0);
      await sweepAt(trx, shift(startsAt, -5 * HOUR));
      expect(await remindersOf(trx, bookingId)).toHaveLength(1);
    }));

  it("skips a booking made inside its last 24 hours, but not one made right at the mark (AC-3)", () =>
    inRollback(async (trx) => {
      const inside = await bookingAt(trx, { noticeLead: 23 });
      await sweepAt(trx, shift(inside.startsAt, -2 * HOUR));
      expect(await remindersOf(trx, inside.bookingId)).toHaveLength(0);

      const atMark = await bookingAt(trx, { startsIn: 96, noticeLead: 24 });
      await sweepAt(trx, shift(atMark.startsAt, -2 * HOUR));
      expect(await remindersOf(trx, atMark.bookingId)).toHaveLength(1);
    }));

  it("judges a rescheduled booking by its new version (AC-3, AC-11)", () =>
    inRollback(async (trx) => {
      // Moved into its last 24 hours: no reminder for the new version.
      const into = await bookingAt(trx);
      const intoStart = shift(into.startsAt, 24 * HOUR);
      await rescheduleTo(trx, into.bookingId, intoStart, 10);
      await sweepAt(trx, shift(intoStart, -5 * HOUR));
      expect(await remindersOf(trx, into.bookingId)).toHaveLength(0);

      // Moved well ahead: due by the new start, for version 2.
      const out = await bookingAt(trx, { startsIn: 120 });
      const outStart = shift(out.startsAt, 24 * HOUR);
      await rescheduleTo(trx, out.bookingId, outStart, 30);
      await sweepAt(trx, shift(out.startsAt, -5 * HOUR));
      expect(await remindersOf(trx, out.bookingId)).toHaveLength(0);
      await sweepAt(trx, shift(outStart, -5 * HOUR));
      const [row] = await remindersOf(trx, out.bookingId);
      expect(row?.booking_version).toBe(2);
    }));

  // covers: spec 0018 AC-5, AC-6. The reminder is built when it is queued,
  // from the live row, so a rename since the booked email shows.
  it("names the testbed by its current Name when queued after a rename", () =>
    inRollback(async (trx) => {
      const { bookingId, startsAt, testbed } = await bookingAt(trx);
      await trx
        .updateTable("testbeds")
        .set({ name: "Renamed Lab" })
        .where("id", "=", testbed.id)
        .execute();
      await sweepAt(trx, shift(startsAt, -5 * HOUR));
      const [row] = await remindersOf(trx, bookingId);
      expect(row?.details).toMatchObject({ testbedName: "Renamed Lab" });
      const seen = JSON.stringify([row?.subject, row?.details]);
      expect(seen).not.toContain(testbed.name);
      expect(seen).not.toContain(testbed.group_name);
    }));

  it("never picks a cancelled booking (AC-2, AC-11)", () =>
    inRollback(async (trx) => {
      const { bookingId, startsAt } = await bookingAt(trx);
      await cancel(trx, bookingId);
      await sweepAt(trx, shift(startsAt, -5 * HOUR));
      expect(await remindersOf(trx, bookingId)).toHaveLength(0);
    }));

  it("never picks a version with no notice row (AC-3)", () =>
    inRollback(async (trx) => {
      const { bookingId, startsAt } = await bookingAt(trx);
      await trx
        .deleteFrom("email_messages")
        .where("booking_id", "=", bookingId)
        .execute();
      await sweepAt(trx, shift(startsAt, -5 * HOUR));
      expect(await remindersOf(trx, bookingId)).toHaveLength(0);
    }));

  it("queues one reminder when run twice (AC-4)", () =>
    inRollback(async (trx) => {
      const { bookingId, startsAt } = await bookingAt(trx);
      const now = shift(startsAt, -5 * HOUR);
      await sweepAt(trx, now);
      await sweepAt(trx, now);
      expect(await remindersOf(trx, bookingId)).toHaveLength(1);
      const jobs = await trx
        .selectFrom("jobs")
        .select("id")
        .where("idempotency_key", "=", reminderJobKey(bookingId, 1))
        .execute();
      expect(jobs).toHaveLength(1);
    }));

  it("reminds again for a new version even after the old version's reminder went out (AC-2, AC-11)", () =>
    inRollback(async (trx) => {
      const { bookingId, startsAt } = await bookingAt(trx, { startsIn: 120 });
      await sweepAt(trx, shift(startsAt, -5 * HOUR));
      await trx
        .updateTable("email_messages")
        .set({ status: "sent" })
        .where("booking_id", "=", bookingId)
        .where("kind", "=", "reminder")
        .execute();

      const moved = shift(startsAt, 24 * HOUR);
      await rescheduleTo(trx, bookingId, moved, 30);
      await sweepAt(trx, shift(moved, -5 * HOUR));

      const rows = await remindersOf(trx, bookingId);
      expect(
        rows
          .map((r) => ({ version: r.booking_version, status: r.status }))
          .sort((a, b) => (a.version ?? 0) - (b.version ?? 0)),
      ).toEqual([
        { version: 1, status: "sent" },
        { version: 2, status: "queued" },
      ]);
    }));

  it("queues the earliest start first when the budget runs out (AC-2)", () =>
    inRollback(async (trx) => {
      // Far past the 90 day horizon, so no real booking sorts in between.
      // The later one is made first, so insert order can't pass for start order.
      const later = await bookingAt(trx, { startsIn: 24 * 200 + 3 });
      const earlier = await bookingAt(trx, { startsIn: 24 * 200 });
      // One read at the start, one before each booking: room for one.
      const ticks = [0, 0, 20_000];
      const result = await queueReminders(asConn(trx), {
        now: shift(earlier.startsAt, -5 * HOUR),
        clock: () => ticks.shift() ?? 20_000,
      });
      expect(result).toEqual({ queued: 1 });
      expect(await remindersOf(trx, earlier.bookingId)).toHaveLength(1);
      expect(await remindersOf(trx, later.bookingId)).toHaveLength(0);
    }));
});

describe.skipIf(!hasDb)(
  "queueReminders: the reminder row (AC-4, AC-5, AC-6)",
  () => {
    it("writes the row, its job, and no calendar job", () =>
      inRollback(async (trx) => {
        const { user, testbed, bookingId, startsAt } = await bookingAt(trx);
        // The notice row's app, not the worker's.
        await trx
          .updateTable("email_messages")
          .set({ details: patched({ appUrl: "https://labs-other.example" }) })
          .where("booking_id", "=", bookingId)
          .execute();
        await sweepAt(trx, shift(startsAt, -5 * HOUR));

        const [row] = await remindersOf(trx, bookingId);
        expect(row).toMatchObject({
          user_id: user.id,
          kind: "reminder",
          status: "queued",
          booking_version: 1,
          to_address: user.email,
        });
        // The zone the booked email used (Kolkata), not users.timezone.
        expect(row?.subject).toMatch(
          /^Reminder: Your Nile Hands-On Lab starts .+ India Time$/,
        );
        expect(row?.details).toMatchObject({
          learnerName: "Priya Raman",
          timezone: "Asia/Kolkata",
          newAccount: false,
          appUrl: "https://labs-other.example",
          links: {
            portalUrl: testbed.portal_url,
            lmsUrl: testbed.lms_url,
            clients: [
              {
                name: "Wireless client",
                kind: "wireless",
                url: "https://c.example.test/wl",
              },
            ],
          },
        });
        expect(JSON.stringify(row?.details)).not.toMatch(/os_|password/i);

        const job = await trx
          .selectFrom("jobs")
          .select(["id", "kind", "payload"])
          .where("idempotency_key", "=", reminderJobKey(bookingId, 1))
          .executeTakeFirstOrThrow();
        expect(job.kind).toBe("send_email");
        expect(job.payload).toEqual({ emailMessageId: row?.id });
        expect(row?.job_id).toBe(job.id);
        const calendar = await trx
          .selectFrom("jobs")
          .select("id")
          .where("idempotency_key", "like", `calendar:${bookingId}:%`)
          .execute();
        expect(calendar).toHaveLength(1); // the booked email's only
      }));

    it("takes the recipient and the lab links as they are when it queues (AC-4, AC-5)", () =>
      inRollback(async (trx) => {
        const { user, testbed, bookingId, startsAt } = await bookingAt(trx);
        const newEmail = `priya-new-${crypto.randomUUID().slice(0, 6)}@acme.com`;
        const newPortal = "https://portal-new.example.test/lab";
        await trx
          .updateTable("users")
          .set({ email: newEmail })
          .where("id", "=", user.id)
          .execute();
        await trx
          .updateTable("testbeds")
          .set({ portal_url: newPortal })
          .where("id", "=", testbed.id)
          .execute();
        await sweepAt(trx, shift(startsAt, -5 * HOUR));

        const [reminder] = await remindersOf(trx, bookingId);
        expect(reminder?.to_address).toBe(newEmail);
        expect(reminder?.details).toMatchObject({
          links: { portalUrl: newPortal },
        });
        // The booked email keeps what it was sent with.
        const booked = await trx
          .selectFrom("email_messages")
          .select("to_address")
          .where("booking_id", "=", bookingId)
          .where("kind", "=", "booked")
          .executeTakeFirstOrThrow();
        expect(booked.to_address).toBe(user.email);
      }));

    it("logs a booking whose notice has no usable appUrl and still queues the rest (AC-4, AC-5)", () =>
      inRollback(async (trx) => {
        const bad = await bookingAt(trx, { startsIn: 70 });
        const good = await bookingAt(trx, { startsIn: 72 });
        await trx
          .updateTable("email_messages")
          .set({ details: JSON.stringify({ appUrl: "not a url" }) })
          .where("booking_id", "=", bad.bookingId)
          .execute();
        const errors = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
          await sweepAt(trx, shift(good.startsAt, -5 * HOUR));
          expect(errors).toHaveBeenCalledWith(
            expect.stringMatching(
              new RegExp(`^reminders: ${bad.bookingId} failed: `),
            ),
          );
        } finally {
          errors.mockRestore();
        }
        expect(await remindersOf(trx, bad.bookingId)).toHaveLength(0);
        expect(await remindersOf(trx, good.bookingId)).toHaveLength(1);
      }));

    it("stops at the time budget and leaves the rest for the next tick (AC-2)", () =>
      inRollback(async (trx) => {
        const { bookingId, startsAt } = await bookingAt(trx);
        const ticks = [0, 20_000];
        const result = await queueReminders(asConn(trx), {
          now: shift(startsAt, -5 * HOUR),
          clock: () => ticks.shift() ?? 20_000,
        });
        expect(result).toEqual({ queued: 0 });
        expect(await remindersOf(trx, bookingId)).toHaveLength(0);
      }));
  },
);

// Bookings 30 real hours out whose reminders are queued and whose booked
// emails already went out, so the handler runs by the real DB clock.
async function queuedReminders(
  trx: Transaction<DB>,
  count: number,
  email?: string,
) {
  await parkRealJobs(trx);
  const made = await Array.from({ length: count }).reduce<
    Promise<Awaited<ReturnType<typeof bookedAndSent>>[]>
  >(
    async (acc) => [...(await acc), await bookedAndSent(trx, email)],
    Promise.resolve([]),
  );
  const [first] = made;
  if (!first) throw new Error("expected a booking");
  await sweepAt(trx, shift(first.startsAt, -5 * HOUR));
  const queued = await Promise.all(
    made.map(async (b) => {
      const [row] = await remindersOf(trx, b.bookingId);
      if (!row?.job_id) throw new Error("expected a reminder");
      return { ...b, reminderId: row.id, jobId: row.job_id };
    }),
  );
  // The sweep also queued reminders for real bookings in that window.
  await trx
    .updateTable("jobs")
    .set({ status: "failed" })
    .where("status", "in", ["pending", "running"])
    .where(
      "id",
      "not in",
      queued.map((q) => q.jobId),
    )
    .execute();
  return queued;
}

async function queuedReminder(trx: Transaction<DB>, email?: string) {
  const [one] = await queuedReminders(trx, 1, email);
  if (!one) throw new Error("expected a reminder");
  return one;
}

async function bookedAndSent(trx: Transaction<DB>, email?: string) {
  const b = await bookingAt(trx, { startsIn: 30, email });
  const booked = await trx
    .updateTable("email_messages")
    .set({ status: "sent" })
    .where("booking_id", "=", b.bookingId)
    .where("kind", "=", "booked")
    .returning("job_id")
    .executeTakeFirstOrThrow();
  await trx
    .updateTable("jobs")
    .set({ status: "done" })
    .where("id", "=", booked.job_id ?? "")
    .execute();
  return b;
}

const run = async (
  trx: Transaction<DB>,
  cfg: Partial<GoogleMailConfig> = {},
) => {
  const google = fakeGoogleFetch(() => ({
    status: 200,
    json: { id: "gmail-msg-1" },
  }));
  await runJobs(asConn(trx), {
    handlers: HANDLERS,
    config: async () => ({ ...config(), ...cfg }),
    fetch: google.fetch,
    mint,
  });
  return google.requests;
};

const statusOf = (trx: Kysely<DB>, id: string) =>
  trx
    .selectFrom("email_messages")
    .select(["status", "last_error"])
    .where("id", "=", id)
    .executeTakeFirstOrThrow();

describe.skipIf(!hasDb)("runSendEmail for a reminder (AC-7 to AC-9)", () => {
  it("sends it with the reminder subject, copy, invite, and no Bcc", () =>
    inRollback(async (trx) => {
      const { reminderId, bookingId } = await queuedReminder(trx);
      const requests = await run(trx);
      expect(requests).toHaveLength(1);
      const [req] = requests;
      if (!req) throw new Error("expected a send");
      const mime = decoded(req);
      expect(mime).toMatch(
        /^Subject: Reminder: Your Nile Hands-On Lab starts/m,
      );
      expect(mime).not.toMatch(/^Bcc:/im);
      expect(mime).toContain("Your lab starts soon");
      const invite = inviteOf(mime);
      expect(invite.method).toBe("REQUEST");
      expect(invite.ics).toContain(`UID:${bookingId}@nile-hol-reservations`);
      expect(invite.ics).toContain("SEQUENCE:1");
      expect(await statusOf(trx, reminderId)).toEqual({
        status: "sent",
        last_error: null,
      });
    }));

  it("still Bccs Ops on the booked email of the same config (AC-9 contrast)", () =>
    inRollback(async (trx) => {
      await parkRealJobs(trx);
      await bookingAt(trx, { startsIn: 30 });
      const [req] = await run(trx);
      if (!req) throw new Error("expected a send");
      expect(decoded(req)).toMatch(/^Bcc: ops@nile\.example/im);
    }));

  it("sends a test address's reminder to the dev inbox with the [dev] prefix (AC-6, AC-9)", () =>
    inRollback(async (trx) => {
      const { reminderId } = await queuedReminder(
        trx,
        `dev-priya-${crypto.randomUUID().slice(0, 6)}@acme.com`,
      );
      const [req] = await run(trx);
      if (!req) throw new Error("expected a send");
      const mime = decoded(req);
      expect(mime).toMatch(/^To: .*dev-inbox@nile\.example/m);
      expect(mime).toMatch(
        /^Subject: \[dev\] Reminder: Your Nile Hands-On Lab starts/m,
      );
      expect(mime).not.toMatch(/^Bcc:/im);
      expect((await statusOf(trx, reminderId)).status).toBe("sent");
    }));

  it("suppresses a test address's reminder when no dev inbox is set (AC-9)", () =>
    inRollback(async (trx) => {
      const { reminderId } = await queuedReminder(
        trx,
        `dev-priya-${crypto.randomUUID().slice(0, 6)}@acme.com`,
      );
      expect(await run(trx, { devInbox: null })).toHaveLength(0);
      expect(await statusOf(trx, reminderId)).toEqual({
        status: "suppressed",
        last_error: SUPPRESSED_NO_DEV_INBOX,
      });
    }));

  it("is suppressed when the booking was cancelled before it sent (AC-8, AC-11)", () =>
    inRollback(async (trx) => {
      const { reminderId, bookingId } = await queuedReminder(trx);
      await cancel(trx, bookingId);
      expect(await run(trx)).toHaveLength(0);
      expect(await statusOf(trx, reminderId)).toEqual({
        status: "suppressed",
        last_error: REMINDER_CHANGED,
      });
    }));

  it("is suppressed when the booking moved to a new version (AC-8, AC-11)", () =>
    inRollback(async (trx) => {
      const { reminderId, bookingId, startsAt } = await queuedReminder(trx);
      // Moved half an hour; the trigger bumps the version.
      const moved = shift(startsAt, HOUR / 2);
      await trx
        .updateTable("bookings")
        .set({ starts_at: moved, ends_at: shift(moved, 2 * HOUR) })
        .where("id", "=", bookingId)
        .execute();
      expect(await run(trx)).toHaveLength(0);
      expect(await statusOf(trx, reminderId)).toEqual({
        status: "suppressed",
        last_error: REMINDER_CHANGED,
      });
    }));

  it("is suppressed under an hour from the start, and sent at exactly an hour (AC-8)", () =>
    inRollback(async (trx) => {
      const now = await dbNow(trx);
      const startAt = (id: string, startsAt: Date) =>
        trx
          .updateTable("email_messages")
          .set({ details: patched({ startsAt: startsAt.toISOString() }) })
          .where("id", "=", id)
          .execute();
      const [close, edge] = await queuedReminders(trx, 2);
      if (!close || !edge) throw new Error("expected two reminders");
      await startAt(close.reminderId, shift(now, LEAD_MS - 1000));
      await startAt(edge.reminderId, shift(now, LEAD_MS));
      expect(await run(trx)).toHaveLength(1);
      expect(await statusOf(trx, close.reminderId)).toEqual({
        status: "suppressed",
        last_error: REMINDER_TOO_CLOSE,
      });
      expect((await statusOf(trx, edge.reminderId)).status).toBe("sent");
    }));
});

describe.skipIf(!hasDb)("claimJob with reminders (AC-10)", () => {
  const jobOf = async (trx: Kysely<DB>, emailId: string) =>
    (
      await trx
        .selectFrom("email_messages")
        .select("job_id")
        .where("id", "=", emailId)
        .executeTakeFirstOrThrow()
    ).job_id;

  const notDue = (trx: Kysely<DB>, jobId: string | null) =>
    trx
      .updateTable("jobs")
      .set({ run_at: new Date("2999-01-01T00:00:00.000Z") })
      .where("id", "=", jobId ?? "")
      .execute();

  it("never holds back a later version's email behind a queued reminder", () =>
    inRollback(async (trx) => {
      const { reminderId, bookingId, startsAt } = await queuedReminder(trx);
      await notDue(trx, await jobOf(trx, reminderId));
      await rescheduleTo(trx, bookingId, shift(startsAt, 2 * HOUR), 30);
      const rescheduled = await trx
        .selectFrom("email_messages")
        .select("job_id")
        .where("booking_id", "=", bookingId)
        .where("kind", "=", "rescheduled")
        .executeTakeFirstOrThrow();
      const claimed = await claimJob(asConn(trx), ["send_email"]);
      expect(claimed?.id).toBe(rescheduled.job_id);
    }));

  it("makes a reminder wait for its own version's queued booked email", () =>
    inRollback(async (trx) => {
      const { reminderId, bookingId } = await queuedReminder(trx);
      const booked = await trx
        .updateTable("email_messages")
        .set({ status: "queued" })
        .where("booking_id", "=", bookingId)
        .where("kind", "=", "booked")
        .returning("job_id")
        .executeTakeFirstOrThrow();
      await trx
        .updateTable("jobs")
        .set({ status: "pending" })
        .where("id", "=", booked.job_id ?? "")
        .execute();
      await notDue(trx, booked.job_id);
      expect(await claimJob(asConn(trx), ["send_email"])).toBeUndefined();

      await trx
        .updateTable("email_messages")
        .set({ status: "sent" })
        .where("booking_id", "=", bookingId)
        .where("kind", "=", "booked")
        .execute();
      const claimed = await claimJob(asConn(trx), ["send_email"]);
      expect(claimed?.id).toBe(await jobOf(trx, reminderId));
    }));
});

describe.skipIf(!hasDb)("the console's Emails section (AC-13)", () => {
  it("lists a reminder with its kind", () =>
    inRollback(async (trx) => {
      const { user } = await queuedReminder(trx);
      const kinds = (await listUserEmails(trx, user.id)).map((e) => e.kind);
      expect(kinds).toContain("reminder");
    }));
});
