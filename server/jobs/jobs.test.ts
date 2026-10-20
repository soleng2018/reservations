import { sql, type Kysely, type Transaction } from "kysely";
import { afterAll, describe, expect, it } from "vitest";
import { err, ok } from "@/lib/result";
import type { GoogleMailConfig } from "@/server/catalog/api-keys";
import { db } from "@/server/db";
import { cancelBooking, rescheduleBooking } from "@/server/db/bookings";
import { confirmGuestBooking } from "@/server/db/guest-saga";
import {
  asConn,
  hasDb,
  inRollback,
  makeTestbed,
  makeType,
  makeUser,
  slot,
} from "@/server/db/testing";
import type { DB } from "@/server/db/types";
import {
  fakeGoogleFetch,
  serviceAccountCredentials,
  type FakeAnswer,
  type RecordedRequest,
} from "@/server/google/testing";
import type { MintError, MintToken } from "@/server/google/token";
import { inviteOf } from "@/server/email/testing";
import { appUrl } from "@/server/env";
import type { GoogleFetch } from "@/server/google/http";
import {
  bookingZone,
  queueBookingNotice,
  type ShownAtBooking,
} from "./booking-notice";
import { queueCalendarBackfill, syncBookingEvent } from "./calendar-sync";
import { breakerMessage, runJobs, type Handlers } from "./runner";
import { runSendEmail } from "./send-email";

// Spec 0013 AC-6 to AC-18: the tracer, from a confirmed booking to a sent
// message, with fake Google calls. Dev and prod share one database, so every
// test parks the real queue inside its rolled back transaction first.

const config = (over: Partial<GoogleMailConfig> = {}): GoogleMailConfig => ({
  id: crypto.randomUUID(),
  credentials: serviceAccountCredentials(),
  secretUpdatedAt: new Date("2026-10-15T00:00:00.000Z"),
  senderEmail: "labs@nile.example",
  calendarId: "c_abc@group.calendar.google.com",
  devInbox: "dev-inbox@nile.example",
  opsBcc: "ops@nile.example",
  // A fresh stamp per call, so no test reuses another's cached token.
  stamp: crypto.randomUUID(),
  ...over,
});

const HANDLERS: Handlers = { send_email: runSendEmail };

const minting = (answers: ("ok" | MintError)[] = ["ok"]) => {
  let n = 0;
  const mint: MintToken = async () => {
    const a = answers[Math.min(n, answers.length - 1)] ?? "ok";
    n += 1;
    return a === "ok"
      ? ok({ token: `token-${n}`, expiresAt: Date.now() + 3_600_000 })
      : err(a);
  };
  return {
    mint,
    get count() {
      return n;
    },
  };
};

const gmail = (answer: (req: RecordedRequest) => FakeAnswer) =>
  fakeGoogleFetch(answer);
const accepted = () =>
  gmail(() => ({ status: 200, json: { id: "gmail-msg-1" } }));

const parkRealJobs = (trx: Kysely<DB>) =>
  trx
    .updateTable("jobs")
    .set({ status: "failed" })
    .where("status", "in", ["pending", "running"])
    .execute();

// A guest booking confirmed through the saga's own step, with two clients.
async function confirmedBooking(
  trx: Transaction<DB>,
  opts: {
    email?: string;
    startsIn?: number;
    hours?: number;
    shown?: ShownAtBooking;
  } = {},
) {
  await parkRealJobs(trx);
  const user = await makeUser(trx, {
    name: "Priya",
    email: opts.email ?? `priya-${crypto.randomUUID().slice(0, 6)}@acme.com`,
    timezone: "America/New_York",
  });
  const type = await makeType(trx, {
    name: `Basic ${crypto.randomUUID().slice(0, 6)}`,
  });
  const testbed = await makeTestbed(trx, type.id);
  await trx
    .insertInto("testbed_clients")
    .values([
      {
        testbed_id: testbed.id,
        kind: "wireless",
        name: "Wireless client",
        url: "https://c.example.test/wl",
        position: 0,
      },
      {
        testbed_id: testbed.id,
        kind: "wired",
        name: "Wired client",
        url: "https://c.example.test/wd",
        position: 1,
      },
    ])
    .execute();
  const startsAt = slot(opts.startsIn ?? 24);
  const booking = await trx
    .insertInto("bookings")
    .values({
      user_id: user.id,
      testbed_id: testbed.id,
      testbed_type_id: type.id,
      starts_at: startsAt,
      ends_at: new Date(startsAt.getTime() + (opts.hours ?? 2) * 3_600_000),
      status: "provisioning",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const confirmed = await confirmGuestBooking(
    trx,
    { userId: user.id, bookingId: booking.id },
    opts.shown ?? { timezone: "America/New_York", newAccount: false },
  );
  if (!confirmed.ok) throw new Error("expected a confirm");
  return { user, type, testbed, bookingId: booking.id };
}

const emailsOf = (trx: Kysely<DB>, bookingId: string) =>
  trx
    .selectFrom("email_messages")
    .selectAll()
    .where("booking_id", "=", bookingId)
    .orderBy("booking_version")
    .execute();

const jobsFor = (trx: Kysely<DB>, keyPrefix: string) =>
  trx
    .selectFrom("jobs")
    .select([
      "kind",
      "status",
      "attempts",
      "idempotency_key",
      "last_error",
      "run_at",
    ])
    .where("idempotency_key", "like", `${keyPrefix}%`)
    .orderBy("created_at")
    // Rows from one inRollback share created_at; the key ends in the version.
    .orderBy("idempotency_key")
    .execute();

const decoded = (req: RecordedRequest) => {
  const { raw } = JSON.parse(req.body ?? "{}") as { raw: string };
  return Buffer.from(raw, "base64url").toString("utf8");
};

afterAll(() => (hasDb ? db().destroy() : undefined));

describe.skipIf(!hasDb)("queueBookingNotice (spec 0013 AC-6, AC-11)", () => {
  it("queues the booked email and its calendar job with the confirm", () =>
    inRollback(async (trx) => {
      const { user, type, testbed, bookingId } = await confirmedBooking(trx);
      const [email] = await emailsOf(trx, bookingId);
      expect(email).toMatchObject({
        user_id: user.id,
        kind: "booked",
        status: "queued",
        booking_version: 1,
        to_address: user.email,
      });
      expect(email?.subject).toMatch(/^Your Nile Hands-On Lab access - .+ ET$/);
      expect(email?.details).toEqual({
        learnerName: "Priya",
        timezone: "America/New_York",
        newAccount: false,
        labTypeName: type.name,
        testbedName: testbed.name,
        startsAt: expect.any(String),
        endsAt: expect.any(String),
        appUrl: appUrl(),
        links: {
          portalUrl: testbed.portal_url,
          lmsUrl: testbed.lms_url,
          clients: [
            {
              name: "Wireless client",
              kind: "wireless",
              url: "https://c.example.test/wl",
            },
            {
              name: "Wired client",
              kind: "wired",
              url: "https://c.example.test/wd",
            },
          ],
        },
      });
      expect(JSON.stringify(email?.details)).not.toMatch(/os_|password/i);
      expect(await jobsFor(trx, `email:${bookingId}`)).toEqual([
        expect.objectContaining({
          kind: "send_email",
          status: "pending",
          idempotency_key: `email:${bookingId}:booked:1`,
        }),
      ]);
      expect(await jobsFor(trx, `calendar:${bookingId}`)).toEqual([
        expect.objectContaining({
          kind: "calendar_upsert",
          idempotency_key: `calendar:${bookingId}:1`,
        }),
      ]);
    }));

  // AC-6, AC-11 (amended 2026-10-16, 2026-10-17): a returning learner who
  // books as a guest keeps their stored zone; the booked email follows the
  // screen, and every later email for that booking keeps the booked zone.
  it("uses the zone the booking screen showed for booked, and keeps it after", () =>
    inRollback(async (trx) => {
      const { user, type, testbed, bookingId } = await confirmedBooking(trx, {
        shown: { timezone: "Asia/Kolkata", newAccount: true },
      });
      const [booked] = await emailsOf(trx, bookingId);
      expect(booked?.details).toMatchObject({
        timezone: "Asia/Kolkata",
        newAccount: true,
      });
      expect(booked?.subject).toMatch(/ India Time$/);
      expect(
        await trx
          .selectFrom("users")
          .select("timezone")
          .where("id", "=", user.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ timezone: "America/New_York" });

      const moved = slot(30);
      await rescheduleBooking(trx, {
        id: bookingId,
        expectedVersion: 1,
        testbedId: testbed.id,
        testbedTypeId: type.id,
        startsAt: moved,
        endsAt: new Date(moved.getTime() + 2 * 3_600_000),
      });
      await cancelBooking(trx, {
        id: bookingId,
        expectedVersion: 2,
        source: "learner",
        byUserId: null,
      });
      const [, rescheduled, cancelled] = await emailsOf(trx, bookingId);
      expect(rescheduled?.details).toMatchObject({
        timezone: "Asia/Kolkata",
        newAccount: false,
      });
      expect(rescheduled?.subject).toMatch(/ India Time$/);
      expect(cancelled?.details).toMatchObject({ timezone: "Asia/Kolkata" });
      expect(cancelled?.subject).toMatch(/ India Time$/);
    }));

  // AC-6, AC-7, AC-11 (amended 2026-10-17): one zone per booking.
  describe("one zone per booking", () => {
    const moveThenCancel = async (
      trx: Kysely<DB>,
      b: { type: { id: string }; testbed: { id: string }; bookingId: string },
    ) => {
      const moved = slot(30);
      expect(
        await rescheduleBooking(trx, {
          id: b.bookingId,
          expectedVersion: 1,
          testbedId: b.testbed.id,
          testbedTypeId: b.type.id,
          startsAt: moved,
          endsAt: new Date(moved.getTime() + 2 * 3_600_000),
        }),
      ).toEqual({ ok: true, value: { version: 2 } });
      expect(
        await cancelBooking(trx, {
          id: b.bookingId,
          expectedVersion: 2,
          source: "learner",
          byUserId: null,
        }),
      ).toEqual({ ok: true, value: { version: 3 } });
      return (await emailsOf(trx, b.bookingId)).map((e) => ({
        kind: e.kind,
        zone: (e.details as { timezone: string }).timezone,
        subject: e.subject,
      }));
    };

    const setZone = (trx: Kysely<DB>, userId: string, timezone: string) =>
      trx
        .updateTable("users")
        .set({ timezone })
        .where("id", "=", userId)
        .execute();

    const bookedRow = (trx: Kysely<DB>, bookingId: string) =>
      trx
        .updateTable("email_messages")
        .where("booking_id", "=", bookingId)
        .where("kind", "=", "booked");

    it("keeps the booked zone after the learner changes theirs", () =>
      inRollback(async (trx) => {
        const b = await confirmedBooking(trx);
        await setZone(trx, b.user.id, "Europe/Berlin");
        const emails = await moveThenCancel(trx, b);
        expect(emails.map((e) => e.zone)).toEqual([
          "America/New_York",
          "America/New_York",
          "America/New_York",
        ]);
        expect(emails.every((e) => / ET$/.test(e.subject))).toBe(true);
      }));

    it("falls back to the stored zone for a booking with no booked email", () =>
      inRollback(async (trx) => {
        const b = await confirmedBooking(trx);
        // As a booking made before this feature: no booked row.
        await trx
          .deleteFrom("email_messages")
          .where("booking_id", "=", b.bookingId)
          .execute();
        await setZone(trx, b.user.id, "Europe/Berlin");
        const emails = await moveThenCancel(trx, b);
        expect(emails.map((e) => [e.kind, e.zone])).toEqual([
          ["rescheduled", "Europe/Berlin"],
          ["cancelled", "Europe/Berlin"],
        ]);
      }));

    it.each(["failed", "suppressed"])(
      "still takes the zone from a %s booked email",
      (status) =>
        inRollback(async (trx) => {
          const b = await confirmedBooking(trx, {
            shown: { timezone: "Asia/Kolkata", newAccount: false },
          });
          await bookedRow(trx, b.bookingId).set({ status }).execute();
          const emails = await moveThenCancel(trx, b);
          expect(emails.map((e) => e.zone)).toEqual([
            "Asia/Kolkata",
            "Asia/Kolkata",
            "Asia/Kolkata",
          ]);
        }),
    );

    it("falls back when the booked zone is not a real zone, and still cancels", () =>
      inRollback(async (trx) => {
        const b = await confirmedBooking(trx);
        await bookedRow(trx, b.bookingId)
          .set({
            details: sql`jsonb_set(details, '{timezone}', '"Mars/Olympus"')`,
          })
          .execute();
        await setZone(trx, b.user.id, "Europe/Berlin");
        const emails = await moveThenCancel(trx, b);
        expect(emails.slice(1).map((e) => e.zone)).toEqual([
          "Europe/Berlin",
          "Europe/Berlin",
        ]);
      }));

    it("names a UTC learner's zone UTC in the subject (AC-14)", () =>
      inRollback(async (trx) => {
        const b = await confirmedBooking(trx, {
          shown: { timezone: "UTC", newAccount: false },
        });
        const emails = await moveThenCancel(trx, b);
        expect(emails.every((e) => / [AP]M UTC$/.test(e.subject))).toBe(true);
      }));
  });

  // covers: AC-7, AC-11 (amended 2026-10-17), bookingZone on its own.
  describe("bookingZone", () => {
    const FALLBACK = "Europe/Berlin";

    const setBookedDetails = (
      trx: Kysely<DB>,
      bookingId: string,
      details: unknown,
    ) =>
      trx
        .updateTable("email_messages")
        .set({ details: sql`${JSON.stringify(details)}::jsonb` })
        .where("booking_id", "=", bookingId)
        .where("kind", "=", "booked")
        .execute();

    it("returns the booked email's zone, not the fallback", () =>
      inRollback(async (trx) => {
        const b = await confirmedBooking(trx, {
          shown: { timezone: "Asia/Kolkata", newAccount: false },
        });
        expect(await bookingZone(trx, b.bookingId, FALLBACK)).toBe(
          "Asia/Kolkata",
        );
      }));

    it.each([
      ["no timezone key", {}],
      ["a number for timezone", { timezone: 5 }],
      ["an empty timezone", { timezone: "" }],
      ["JSON null", null],
    ])("falls back when the booked details hold %s", (_label, details) =>
      inRollback(async (trx) => {
        const b = await confirmedBooking(trx);
        await setBookedDetails(trx, b.bookingId, details);
        expect(await bookingZone(trx, b.bookingId, FALLBACK)).toBe(FALLBACK);
      }),
    );

    it("falls back for a booking id that has no rows at all", () =>
      inRollback(async (trx) => {
        expect(await bookingZone(trx, crypto.randomUUID(), FALLBACK)).toBe(
          FALLBACK,
        );
      }));

    it("never reads another booking's booked email", () =>
      inRollback(async (trx) => {
        await confirmedBooking(trx, {
          shown: { timezone: "Asia/Kolkata", newAccount: false },
        });
        const other = await confirmedBooking(trx);
        await trx
          .deleteFrom("email_messages")
          .where("booking_id", "=", other.bookingId)
          .execute();
        expect(await bookingZone(trx, other.bookingId, FALLBACK)).toBe(
          FALLBACK,
        );
      }));

    it("ignores a rescheduled email's zone when the booked row is gone", () =>
      inRollback(async (trx) => {
        const b = await confirmedBooking(trx);
        const moved = slot(30);
        await rescheduleBooking(trx, {
          id: b.bookingId,
          expectedVersion: 1,
          testbedId: b.testbed.id,
          testbedTypeId: b.type.id,
          startsAt: moved,
          endsAt: new Date(moved.getTime() + 2 * 3_600_000),
        });
        await trx
          .deleteFrom("email_messages")
          .where("booking_id", "=", b.bookingId)
          .where("kind", "=", "booked")
          .execute();
        await trx
          .updateTable("email_messages")
          .set({
            details: sql`jsonb_set(details, '{timezone}', '"Asia/Kolkata"')`,
          })
          .where("booking_id", "=", b.bookingId)
          .where("kind", "=", "rescheduled")
          .execute();
        expect(await bookingZone(trx, b.bookingId, FALLBACK)).toBe(FALLBACK);
      }));
  });

  it("queues nothing when the booking change rolls back", () =>
    inRollback(async (trx) => {
      await parkRealJobs(trx);
      const before = await trx
        .selectFrom("email_messages")
        .select(sql<number>`count(*)::int`.as("n"))
        .executeTakeFirstOrThrow();
      await sql`savepoint undo`.execute(trx);
      await confirmedBooking(trx);
      await sql`rollback to savepoint undo`.execute(trx);
      const after = await trx
        .selectFrom("email_messages")
        .select(sql<number>`count(*)::int`.as("n"))
        .executeTakeFirstOrThrow();
      expect(after.n).toBe(before.n);
    }));
});

describe.skipIf(!hasDb)(
  "the jobs step (spec 0013 AC-8, AC-15 to AC-18)",
  () => {
    it("sends the booked email once, as one MIME message, and marks it sent", () =>
      inRollback(async (trx) => {
        const { user, bookingId } = await confirmedBooking(trx);
        const google = accepted();
        const step = await runJobs(asConn(trx), {
          handlers: HANDLERS,
          config: async () => config(),
          fetch: google.fetch,
          mint: minting().mint,
        });
        expect(step).toEqual({
          kind: "ran",
          ran: 1,
          breaker: false,
          failed: [],
          method: "service_account",
        });
        expect(google.requests).toHaveLength(1);
        const [req] = google.requests;
        if (!req) throw new Error("expected a send");
        expect(req.url).toBe(
          "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
        );
        expect(req.headers.authorization).toBe("Bearer token-1");
        const mime = decoded(req);
        expect(mime).toContain(`To: ${user.email}`);
        expect(mime).toContain("Bcc: ops@nile.example");
        const invite = inviteOf(mime);
        expect(invite.method).toBe("REQUEST");
        expect(invite.ics).toMatch(/^SEQUENCE:1\r?$/m);
        const [email] = await emailsOf(trx, bookingId);
        expect(email).toMatchObject({
          status: "sent",
          provider_message_id: "gmail-msg-1",
          sent_to: user.email,
          last_error: null,
        });
        expect(email?.sent_at).toBeInstanceOf(Date);
        expect(await jobsFor(trx, `email:${bookingId}`)).toEqual([
          expect.objectContaining({ status: "done", attempts: 1 }),
        ]);
        // The step again finds nothing to send.
        await runJobs(asConn(trx), {
          handlers: HANDLERS,
          config: async () => config(),
          fetch: google.fetch,
          mint: minting().mint,
        });
        expect(google.requests).toHaveLength(1);
      }));

    it("reroutes a dev- learner to the dev inbox with [dev] and no Bcc", () =>
      inRollback(async (trx) => {
        const { bookingId } = await confirmedBooking(trx, {
          email: `dev-${crypto.randomUUID().slice(0, 6)}@acme.com`,
        });
        const google = accepted();
        await runJobs(asConn(trx), {
          handlers: HANDLERS,
          config: async () => config(),
          fetch: google.fetch,
          mint: minting().mint,
        });
        const [req] = google.requests;
        if (!req) throw new Error("expected a send");
        const mime = decoded(req);
        expect(mime).toContain("To: dev-inbox@nile.example");
        expect(mime).toMatch(
          /^Subject: \[dev\] Your Nile Hands-On Lab access/m,
        );
        expect(mime).not.toMatch(/^Bcc:/m);
        const [email] = await emailsOf(trx, bookingId);
        expect(email).toMatchObject({
          status: "sent",
          sent_to: "dev-inbox@nile.example",
        });
        expect(email?.subject).not.toMatch(/^\[dev\]/);
      }));

    it("suppresses a test address when no dev inbox is set", () =>
      inRollback(async (trx) => {
        const { bookingId } = await confirmedBooking(trx, {
          email: `learner-${crypto.randomUUID().slice(0, 6)}@example.test`,
        });
        const google = accepted();
        await runJobs(asConn(trx), {
          handlers: HANDLERS,
          config: async () => config({ devInbox: null }),
          fetch: google.fetch,
          mint: minting().mint,
        });
        expect(google.requests).toHaveLength(0);
        const [email] = await emailsOf(trx, bookingId);
        expect(email).toMatchObject({
          status: "suppressed",
          last_error: "Test address and no dev inbox is set.",
        });
      }));

    it("suppresses an email whose booking already ended (AC-18)", () =>
      inRollback(async (trx) => {
        const { bookingId } = await confirmedBooking(trx, {
          startsIn: -5,
          hours: 2,
        });
        const google = accepted();
        await runJobs(asConn(trx), {
          handlers: HANDLERS,
          config: async () => config(),
          fetch: google.fetch,
          mint: minting().mint,
        });
        expect(google.requests).toHaveLength(0);
        const [email] = await emailsOf(trx, bookingId);
        expect(email).toMatchObject({
          status: "suppressed",
          last_error: "The booking had already ended.",
        });
        expect(await jobsFor(trx, `email:${bookingId}`)).toEqual([
          expect.objectContaining({ status: "done" }),
        ]);
      }));

    it("backs off on a 503 and fails a final 4xx with its row (AC-8, AC-15)", () =>
      inRollback(async (trx) => {
        const { bookingId } = await confirmedBooking(trx);
        const down = gmail(() => ({ status: 503 }));
        await runJobs(asConn(trx), {
          handlers: HANDLERS,
          config: async () => config(),
          fetch: down.fetch,
          mint: minting().mint,
        });
        const [retried] = await jobsFor(trx, `email:${bookingId}`);
        expect(retried).toMatchObject({ status: "pending", attempts: 1 });
        const [queued] = await emailsOf(trx, bookingId);
        expect(queued).toMatchObject({
          status: "queued",
          last_error: "Gmail didn't take the message yet. Retrying.",
        });
        // About a minute out, by the DB clock.
        const { delta } = await sql<{ delta: number }>`
        select extract(epoch from (${retried?.run_at} - now()))::int as delta`
          .execute(trx)
          .then((r) => r.rows[0] ?? { delta: -1 });
        expect(delta).toBeGreaterThanOrEqual(55);
        expect(delta).toBeLessThanOrEqual(65);

        // Due again now, and Gmail refuses for good.
        await trx
          .updateTable("jobs")
          .set({ run_at: sql<Date>`now()` })
          .where("idempotency_key", "=", `email:${bookingId}:booked:1`)
          .execute();
        const refused = gmail(() => ({ status: 400 }));
        const step = await runJobs(asConn(trx), {
          handlers: HANDLERS,
          config: async () => config(),
          fetch: refused.fetch,
          mint: minting().mint,
        });
        expect(step).toMatchObject({
          failed: [expect.stringMatching(/^send_email /)],
        });
        expect(await jobsFor(trx, `email:${bookingId}`)).toEqual([
          expect.objectContaining({ status: "failed", attempts: 2 }),
        ]);
        const [failed] = await emailsOf(trx, bookingId);
        expect(failed).toMatchObject({
          status: "failed",
          last_error: "Gmail refused the message (400).",
        });
      }));

    it("fails the job and its row on the 8th retry, and an exhausted lease (AC-8)", () =>
      inRollback(async (trx) => {
        const { bookingId } = await confirmedBooking(trx);
        await trx
          .updateTable("jobs")
          .set({ attempts: 7 })
          .where("idempotency_key", "=", `email:${bookingId}:booked:1`)
          .execute();
        await runJobs(asConn(trx), {
          handlers: HANDLERS,
          config: async () => config(),
          fetch: gmail(() => ({ status: 503 })).fetch,
          mint: minting().mint,
        });
        expect(await jobsFor(trx, `email:${bookingId}`)).toEqual([
          expect.objectContaining({ status: "failed", attempts: 8 }),
        ]);
        expect((await emailsOf(trx, bookingId))[0]?.status).toBe("failed");

        const other = await confirmedBooking(trx);
        await trx
          .updateTable("jobs")
          .set({
            status: "running",
            attempts: 8,
            locked_until: sql<Date>`now() - interval '1 minute'`,
          })
          .where("idempotency_key", "=", `email:${other.bookingId}:booked:1`)
          .execute();
        const google = accepted();
        await runJobs(asConn(trx), {
          handlers: HANDLERS,
          config: async () => config(),
          fetch: google.fetch,
          mint: minting().mint,
        });
        expect(google.requests).toHaveLength(0);
        expect(await jobsFor(trx, `email:${other.bookingId}`)).toEqual([
          expect.objectContaining({
            status: "failed",
            attempts: 8,
            last_error: "The worker stopped during the last attempt.",
          }),
        ]);
        expect((await emailsOf(trx, other.bookingId))[0]?.status).toBe(
          "failed",
        );
      }));

    it("finishes without sending when the row is no longer queued (AC-15)", () =>
      inRollback(async (trx) => {
        const { bookingId } = await confirmedBooking(trx);
        await trx
          .updateTable("email_messages")
          .set({ status: "sent" })
          .where("booking_id", "=", bookingId)
          .execute();
        const google = accepted();
        await runJobs(asConn(trx), {
          handlers: HANDLERS,
          config: async () => config(),
          fetch: google.fetch,
          mint: minting().mint,
        });
        expect(google.requests).toHaveLength(0);
        expect(await jobsFor(trx, `email:${bookingId}`)).toEqual([
          expect.objectContaining({ status: "done" }),
        ]);
      }));
  },
);

describe.skipIf(!hasDb)("no key and the breaker (spec 0013 AC-9)", () => {
  it("claims nothing and spends no attempt with no Google key", () =>
    inRollback(async (trx) => {
      const { bookingId } = await confirmedBooking(trx);
      expect(
        await runJobs(asConn(trx), {
          handlers: HANDLERS,
          config: async () => null,
        }),
      ).toEqual({ kind: "no_key" });
      expect(await jobsFor(trx, `email:${bookingId}`)).toEqual([
        expect.objectContaining({ status: "pending", attempts: 0 }),
      ]);
    }));

  it("mints a fresh token after one 401 and sends", () =>
    inRollback(async (trx) => {
      const { bookingId } = await confirmedBooking(trx);
      const google = gmail((req) =>
        req.headers.authorization === "Bearer token-1"
          ? { status: 401 }
          : { status: 200, json: { id: "gmail-msg-2" } },
      );
      const tokens = minting();
      await runJobs(asConn(trx), {
        handlers: HANDLERS,
        config: async () => config(),
        fetch: google.fetch,
        mint: tokens.mint,
      });
      expect(tokens.count).toBe(2);
      expect((await emailsOf(trx, bookingId))[0]).toMatchObject({
        status: "sent",
        provider_message_id: "gmail-msg-2",
      });
    }));

  it.each<[string, ("ok" | MintError)[], FakeAnswer]>([
    [
      "a rejected key when minting",
      ["invalid"],
      { status: 200, json: { id: "x" } },
    ],
    ["a second 401", ["ok"], { status: 401 }],
  ])(
    "trips on %s: the attempt comes back and the step stops",
    (_label, mints, answer) =>
      inRollback(async (trx) => {
        const first = await confirmedBooking(trx);
        const second = await confirmedBooking(trx);
        const step = await runJobs(asConn(trx), {
          handlers: HANDLERS,
          config: async () => config(),
          fetch: gmail(() => answer).fetch,
          mint: minting(mints).mint,
        });
        expect(step).toEqual({
          kind: "ran",
          ran: 1,
          breaker: true,
          failed: [],
          method: "service_account",
        });
        const jobs = [
          ...(await jobsFor(trx, `email:${first.bookingId}`)),
          ...(await jobsFor(trx, `email:${second.bookingId}`)),
        ];
        expect(jobs.map((j) => j.attempts).sort()).toEqual([0, 0]);
        const tripped = jobs.find((j) => j.last_error !== null);
        expect(tripped).toMatchObject({
          status: "pending",
          last_error: breakerMessage("service_account"),
        });
        const emails = [
          ...(await emailsOf(trx, first.bookingId)),
          ...(await emailsOf(trx, second.bookingId)),
        ];
        expect(emails.map((e) => e.status)).toEqual(["queued", "queued"]);
        expect(
          emails.filter(
            (e) => e.last_error === breakerMessage("service_account"),
          ),
        ).toHaveLength(1);
        // AC-5: no token or key text in any stored error.
        expect(JSON.stringify([jobs, emails])).not.toMatch(
          /token-\d|ya29\.|PRIVATE KEY/,
        );
      }),
  );
});

// covers: spec 0013 AC-30, AC-31 (the breaker by method, and the marker)
describe.skipIf(!hasDb)("the Needs attention marker (spec 0013 AC-31)", () => {
  // A live GOOGLE key row, so the marker has something to mark. Any other
  // live GOOGLE key is parked inside the rolled back transaction first.
  const googleKey = async (trx: Kysely<DB>) => {
    await trx
      .updateTable("api_keys")
      .set({ deleted_at: new Date() })
      .where("type", "=", "GOOGLE")
      .where("deleted_at", "is", null)
      .execute();
    return trx
      .insertInto("api_keys")
      .values({
        name: `Google ${crypto.randomUUID().slice(0, 8)}`,
        type: "GOOGLE",
        base_url: "https://www.googleapis.com",
        secret_ciphertext: "v1:test:placeholder",
        google_auth: "service_account",
        sender_email: "labs@nile.example",
        calendar_id: "c_abc@group.calendar.google.com",
      })
      .returning(["id", "secret_updated_at"])
      .executeTakeFirstOrThrow();
  };

  const rejectedAt = async (trx: Kysely<DB>, id: string) =>
    (
      await trx
        .selectFrom("api_keys")
        .select("google_rejected_at")
        .where("id", "=", id)
        .executeTakeFirstOrThrow()
    ).google_rejected_at;

  it("marks the key when the breaker trips, and the next successful call clears it", () =>
    inRollback(async (trx) => {
      const key = await googleKey(trx);
      const cfg = config({
        id: key.id,
        secretUpdatedAt: key.secret_updated_at,
      });
      await confirmedBooking(trx);
      const tripped = await runJobs(asConn(trx), {
        handlers: HANDLERS,
        config: async () => cfg,
        fetch: gmail(() => ({ status: 200, json: { id: "x" } })).fetch,
        mint: minting(["invalid"]).mint,
      });
      expect(tripped).toMatchObject({ breaker: true });
      expect(await rejectedAt(trx, key.id)).toBeInstanceOf(Date);

      // The breaker's wait is over; the key works again.
      await trx
        .updateTable("jobs")
        .set({ run_at: new Date(Date.now() - 60_000) })
        .where("status", "=", "pending")
        .execute();
      const sent = await runJobs(asConn(trx), {
        handlers: HANDLERS,
        config: async () => ({ ...cfg, stamp: crypto.randomUUID() }),
        fetch: accepted().fetch,
        mint: minting().mint,
      });
      expect(sent).toMatchObject({ breaker: false, ran: 1 });
      expect(await rejectedAt(trx, key.id)).toBeNull();
    }));

  it("never marks a secret saved after the worker read its config", () =>
    inRollback(async (trx) => {
      const key = await googleKey(trx);
      await confirmedBooking(trx);
      await runJobs(asConn(trx), {
        handlers: HANDLERS,
        // The config the worker read holds the secret before the save.
        config: async () =>
          config({
            id: key.id,
            secretUpdatedAt: new Date(key.secret_updated_at.getTime() - 60_000),
          }),
        fetch: gmail(() => ({ status: 200, json: { id: "x" } })).fetch,
        mint: minting(["invalid"]).mint,
      });
      expect(await rejectedAt(trx, key.id)).toBeNull();
    }));

  // The sign in key's canaries, for the leak checks (AC-33).
  const SIGN_IN = {
    method: "oauth",
    clientId: "1234-abc.apps.googleusercontent.com",
    clientSecret: "GOCSPX-canary-secret",
    refreshToken: "1//canary-refresh",
  } as const;

  // Every console line a run writes, so a test can check none carries a
  // secret.
  const capturingLogs = async <T>(run: () => Promise<T>) => {
    const lines: string[] = [];
    const keep = (...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    };
    const { log, error, warn } = console;
    console.log = keep;
    console.error = keep;
    console.warn = keep;
    try {
      return { result: await run(), lines };
    } finally {
      console.log = log;
      console.error = error;
      console.warn = warn;
    }
  };

  it("sends through a Google sign in key with the refresh grant's token (AC-30)", () =>
    inRollback(async (trx) => {
      const { bookingId } = await confirmedBooking(trx);
      const google = gmail((req) =>
        req.url === "https://oauth2.googleapis.com/token"
          ? {
              status: 200,
              json: { access_token: "ya29.canary-access", expires_in: 3599 },
            }
          : { status: 200, json: { id: "gmail-msg-oauth" } },
      );
      const { result, lines } = await capturingLogs(() =>
        runJobs(asConn(trx), {
          handlers: HANDLERS,
          config: async () =>
            config({
              credentials: SIGN_IN,
              senderEmail: "hol.sender@gmail.com",
            }),
          fetch: google.fetch,
        }),
      );
      expect(result).toMatchObject({ ran: 1, breaker: false, method: "oauth" });
      const [mint, send] = google.requests;
      expect(mint?.url).toBe("https://oauth2.googleapis.com/token");
      expect(send?.headers.authorization).toBe("Bearer ya29.canary-access");
      const [email] = await emailsOf(trx, bookingId);
      expect(email).toMatchObject({
        status: "sent",
        provider_message_id: "gmail-msg-oauth",
      });
      const jobs = await jobsFor(trx, `email:${bookingId}`);
      expect(JSON.stringify([jobs, email, lines])).not.toMatch(/canary|GOCSPX/);
    }));

  it("names Google sign in in the breaker's message for a sign in key (AC-30, AC-31)", () =>
    inRollback(async (trx) => {
      const { bookingId } = await confirmedBooking(trx);
      // The real refresh grant through the fake fetch: Google says the
      // sign in is gone.
      const google = gmail((req) =>
        req.url === "https://oauth2.googleapis.com/token"
          ? { status: 400, json: { error: "invalid_grant" } }
          : { status: 200, json: { id: "x" } },
      );
      const { result: step, lines } = await capturingLogs(() =>
        runJobs(asConn(trx), {
          handlers: HANDLERS,
          config: async () => config({ credentials: SIGN_IN }),
          fetch: google.fetch,
        }),
      );
      expect(step).toMatchObject({ breaker: true, method: "oauth" });
      expect(google.requests.map((r) => r.url)).toEqual([
        "https://oauth2.googleapis.com/token",
      ]);
      const [email] = await emailsOf(trx, bookingId);
      expect(email).toMatchObject({
        status: "queued",
        last_error: breakerMessage("oauth"),
      });
      const jobs = await jobsFor(trx, `email:${bookingId}`);
      expect(jobs).toEqual([
        expect.objectContaining({ status: "pending", attempts: 0 }),
      ]);
      expect(JSON.stringify([jobs, email, lines])).not.toMatch(/canary|GOCSPX/);
    }));
});

describe.skipIf(!hasDb)(
  "reschedule and cancel (spec 0013 AC-6, AC-10, AC-13)",
  () => {
    it("sends booked, rescheduled, and cancelled in version order, even when the later jobs are due first", () =>
      inRollback(async (trx) => {
        const { type, testbed, bookingId } = await confirmedBooking(trx);
        const moved = slot(30);
        const rescheduled = await rescheduleBooking(trx, {
          id: bookingId,
          expectedVersion: 1,
          testbedId: testbed.id,
          testbedTypeId: type.id,
          startsAt: moved,
          endsAt: new Date(moved.getTime() + 2 * 3_600_000),
        });
        expect(rescheduled).toEqual({ ok: true, value: { version: 2 } });
        const cancelled = await cancelBooking(trx, {
          id: bookingId,
          expectedVersion: 2,
          source: "learner",
          byUserId: null,
        });
        expect(cancelled).toEqual({ ok: true, value: { version: 3 } });

        const emails = await emailsOf(trx, bookingId);
        expect(emails.map((e) => [e.kind, e.booking_version])).toEqual([
          ["booked", 1],
          ["rescheduled", 2],
          ["cancelled", 3],
        ]);
        expect(emails[2]?.details).toMatchObject({ links: null });
        expect(
          (await jobsFor(trx, `calendar:${bookingId}`)).map((j) => j.kind),
        ).toEqual(["calendar_upsert", "calendar_upsert", "calendar_delete"]);

        // The later jobs are due first.
        await trx
          .updateTable("jobs")
          .set({ run_at: sql<Date>`now() - interval '1 hour'` })
          .where("idempotency_key", "in", [
            `email:${bookingId}:cancelled:3`,
            `email:${bookingId}:rescheduled:2`,
          ])
          .execute();
        const google = accepted();
        await runJobs(asConn(trx), {
          handlers: HANDLERS,
          config: async () => config(),
          fetch: google.fetch,
          mint: minting().mint,
        });
        const sent = google.requests.map((r) => decoded(r));
        expect(sent.map((m) => m.match(/^Subject: (\S+)/m)?.[1])).toEqual([
          "Your",
          "Updated:",
          "Cancelled:",
        ]);
        const invites = sent.map(inviteOf);
        expect(invites.map((i) => i.method)).toEqual([
          "REQUEST",
          "REQUEST",
          "CANCEL",
        ]);
        expect(invites[1]?.ics).toMatch(/^SEQUENCE:2\r?$/m);
        expect(invites[2]?.ics).toMatch(/^SEQUENCE:3\r?$/m);
        expect((await emailsOf(trx, bookingId)).map((e) => e.status)).toEqual([
          "sent",
          "sent",
          "sent",
        ]);
      }));

    it("lets a later email go once an older one has failed for good (AC-8, AC-10)", () =>
      inRollback(async (trx) => {
        const { bookingId } = await confirmedBooking(trx);
        await cancelBooking(trx, {
          id: bookingId,
          expectedVersion: 1,
          source: "admin",
          byUserId: null,
        });
        const google = gmail((req) =>
          decoded(req).includes("Subject: Your Nile")
            ? { status: 400 }
            : { status: 200, json: { id: "gmail-cancel" } },
        );
        await runJobs(asConn(trx), {
          handlers: HANDLERS,
          config: async () => config(),
          fetch: google.fetch,
          mint: minting().mint,
        });
        expect((await emailsOf(trx, bookingId)).map((e) => e.status)).toEqual([
          "failed",
          "sent",
        ]);
      }));

    it("queues one notice per change: a repeat of the same version adds nothing", () =>
      inRollback(async (trx) => {
        const { bookingId } = await confirmedBooking(trx);
        await queueBookingNotice(trx, bookingId, 1, "booked");
        expect(await emailsOf(trx, bookingId)).toHaveLength(1);
        expect(await jobsFor(trx, `email:${bookingId}`)).toHaveLength(1);
        expect(await jobsFor(trx, `calendar:${bookingId}`)).toHaveLength(1);
      }));

    it("queues nothing for a stale cancel", () =>
      inRollback(async (trx) => {
        const { bookingId } = await confirmedBooking(trx);
        expect(
          await cancelBooking(trx, {
            id: bookingId,
            expectedVersion: 7,
            source: "learner",
            byUserId: null,
          }),
        ).toEqual({ ok: false, error: "stale" });
        expect(await emailsOf(trx, bookingId)).toHaveLength(1);
      }));
  },
);

// A fake shared calendar: events by id, with Google's status codes.
const fakeCalendar = (opts: { conflictOnce?: boolean } = {}) => {
  const events = new Map<string, { summary: string; start: string }>();
  let conflict = opts.conflictOnce ?? false;
  const google = fakeGoogleFetch((req) => {
    const m = req.url.match(
      /\/calendars\/([^/]+)\/events(?:\/([^?]+))?\?sendUpdates=none$/,
    );
    if (!m) return { status: 400 };
    const id = m[2];
    const body = req.body
      ? (JSON.parse(req.body) as Record<string, unknown>)
      : {};
    const stored = () => ({
      summary: String(body.summary),
      start: String((body.start as { dateTime: string }).dateTime),
    });
    switch (req.method) {
      case "PUT":
        if (!id || !events.has(id)) return { status: 404 };
        events.set(id, stored());
        return { status: 200, json: {} };
      case "POST": {
        const newId = String(body.id);
        if (conflict) {
          conflict = false;
          events.set(newId, { summary: "made by another run", start: "" });
          return { status: 409 };
        }
        if (events.has(newId)) return { status: 409 };
        events.set(newId, stored());
        return { status: 200, json: {} };
      }
      case "DELETE":
        if (!id || !events.has(id)) return { status: 410 };
        events.delete(id);
        return { status: 204 };
      default:
        return { status: 405 };
    }
  });
  return { ...google, events };
};

const CALENDAR_HANDLERS: Handlers = {
  calendar_upsert: syncBookingEvent,
  calendar_delete: syncBookingEvent,
};

describe.skipIf(!hasDb)("the calendar mirror (spec 0013 AC-19, AC-20)", () => {
  const runCalendar = (trx: Transaction<DB>, fetch: GoogleFetch) =>
    runJobs(asConn(trx), {
      handlers: CALENDAR_HANDLERS,
      config: async () => config(),
      fetch,
      mint: minting().mint,
    });

  it("creates one event, moves it on reschedule, and deletes it on cancel", () =>
    inRollback(async (trx) => {
      const { user, type, testbed, bookingId } = await confirmedBooking(trx);
      const cal = fakeCalendar();
      await runCalendar(trx, cal.fetch);
      const eventId = bookingId.replaceAll("-", "");
      expect([...cal.events.keys()]).toEqual([eventId]);
      expect(cal.events.get(eventId)?.summary).toBe(
        `${user.name} · ${type.name} · ${testbed.name}`,
      );
      expect(cal.requests[0]?.url).toContain(
        "/calendars/c_abc%40group.calendar.google.com/events/",
      );
      const stamped = await trx
        .selectFrom("bookings")
        .select(["calendar_event_id", "version"])
        .where("id", "=", bookingId)
        .executeTakeFirstOrThrow();
      expect(stamped).toEqual({ calendar_event_id: eventId, version: 1 });

      const moved = slot(40);
      await rescheduleBooking(trx, {
        id: bookingId,
        expectedVersion: 1,
        testbedId: testbed.id,
        testbedTypeId: type.id,
        startsAt: moved,
        endsAt: new Date(moved.getTime() + 2 * 3_600_000),
      });
      await runCalendar(trx, cal.fetch);
      expect(cal.events.size).toBe(1);
      expect(cal.events.get(eventId)?.start).toBe(moved.toISOString());

      await cancelBooking(trx, {
        id: bookingId,
        expectedVersion: 2,
        source: "learner",
        byUserId: null,
      });
      await runCalendar(trx, cal.fetch);
      expect(cal.events.size).toBe(0);
      // Deleting an event that is already gone is done.
      await queueCalendarJob(trx, bookingId, 99);
      await runCalendar(trx, cal.fetch);
      expect(
        (await jobsFor(trx, `calendar:${bookingId}`)).every(
          (j) => j.status === "done",
        ),
      ).toBe(true);
      expect(
        cal.requests.every(
          (r) => r.body === undefined || !r.body.includes("attendees"),
        ),
      ).toBe(true);
    }));

  it("falls back to an update when a concurrent run inserted first (409)", () =>
    inRollback(async (trx) => {
      const { bookingId } = await confirmedBooking(trx);
      const cal = fakeCalendar({ conflictOnce: true });
      await runCalendar(trx, cal.fetch);
      expect(cal.requests.map((r) => r.method)).toEqual(["PUT", "POST", "PUT"]);
      expect(cal.events.get(bookingId.replaceAll("-", ""))?.summary).toMatch(
        /^Priya · /,
      );
    }));

  it("marks a test learner's event [dev]", () =>
    inRollback(async (trx) => {
      const { bookingId } = await confirmedBooking(trx, {
        email: `hol-test-${crypto.randomUUID().slice(0, 6)}@acme.com`,
      });
      const cal = fakeCalendar();
      await runCalendar(trx, cal.fetch);
      expect(cal.events.get(bookingId.replaceAll("-", ""))?.summary).toMatch(
        /^\[dev\] Priya · /,
      );
    }));

  it("never touches the email when the calendar fails", () =>
    inRollback(async (trx) => {
      const { bookingId } = await confirmedBooking(trx);
      await runCalendar(trx, fakeGoogleFetch(() => ({ status: 403 })).fetch);
      expect(await jobsFor(trx, `calendar:${bookingId}`)).toEqual([
        expect.objectContaining({
          status: "failed",
          last_error: "Google Calendar refused the change (403).",
        }),
      ]);
      expect((await emailsOf(trx, bookingId))[0]).toMatchObject({
        status: "queued",
        last_error: null,
      });
    }));

  it("backfills each live confirmed booking once (AC-20)", () =>
    inRollback(async (trx) => {
      const { bookingId } = await confirmedBooking(trx);
      // As if the booking predated the feature: no calendar job yet.
      await trx
        .deleteFrom("jobs")
        .where("idempotency_key", "=", `calendar:${bookingId}:1`)
        .execute();
      const due = await queueCalendarBackfill(asConn(trx), false);
      expect(due).toBeGreaterThanOrEqual(1);
      expect(await jobsFor(trx, `calendar:${bookingId}`)).toHaveLength(0);
      expect(await queueCalendarBackfill(asConn(trx), true)).toBe(due);
      expect(await jobsFor(trx, `calendar:${bookingId}`)).toEqual([
        expect.objectContaining({ kind: "calendar_upsert", status: "pending" }),
      ]);
      expect(await queueCalendarBackfill(asConn(trx), true)).toBe(0);
      expect(await emailsOf(trx, bookingId)).toHaveLength(1);
    }));
});

const queueCalendarJob = (
  trx: Kysely<DB>,
  bookingId: string,
  version: number,
) =>
  trx
    .insertInto("jobs")
    .values({
      kind: "calendar_delete",
      payload: JSON.stringify({ bookingId }),
      idempotency_key: `calendar:${bookingId}:${version}`,
    })
    .execute();
