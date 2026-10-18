import { createHash } from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { ok } from "@/lib/result";
import { SUPPRESSED_NO_DEV_INBOX } from "@/lib/email-routing";
import { linkState } from "@/server/auth/set-password-links";
import type { GoogleMailConfig } from "@/server/catalog/api-keys";
import { db } from "@/server/db";
import { asConn, hasDb, inRollback, makeUser } from "@/server/db/testing";
import type { DB } from "@/server/db/types";
import {
  fakeGoogleFetch,
  serviceAccountCredentials,
  type FakeAnswer,
  type RecordedRequest,
} from "@/server/google/testing";
import type { MintToken } from "@/server/google/token";
import { runJobs, type Handlers } from "./runner";
import { GMAIL_RETRY } from "./send-email";
import { runSendWelcome, STALE_WELCOME } from "./send-welcome";
import {
  enqueueWelcome,
  emailChangeKey,
  resendKey,
  welcomeKey,
} from "./welcome-queue";

// covers: spec 0014 AC-1 to AC-6, AC-8, AC-18 (the send_welcome handler),
// with fake Gmail. Dev and prod share one database, so every test parks the
// real queue inside its rolled back transaction first.

const APP = "https://labs.nile.example";
const HANDLERS: Handlers = { send_welcome: runSendWelcome };

const config = (over: Partial<GoogleMailConfig> = {}): GoogleMailConfig => ({
  id: crypto.randomUUID(),
  credentials: serviceAccountCredentials(),
  secretUpdatedAt: new Date("2026-10-15T00:00:00.000Z"),
  senderEmail: "labs@nile.example",
  calendarId: "c_abc@group.calendar.google.com",
  devInbox: "dev-inbox@nile.example",
  opsBcc: "ops@nile.example",
  stamp: crypto.randomUUID(),
  ...over,
});

const mint: MintToken = async () =>
  ok({ token: "token-1", expiresAt: Date.now() + 3_600_000 });

const gmail = (answer: (req: RecordedRequest) => FakeAnswer) =>
  fakeGoogleFetch(answer);
const accepted = () =>
  gmail(() => ({ status: 200, json: { id: "gmail-welcome-1" } }));

const decoded = (req: RecordedRequest | undefined) => {
  const { raw } = JSON.parse(req?.body ?? "{}") as { raw: string };
  // Quoted printable soft breaks would split the link.
  return Buffer.from(raw, "base64url")
    .toString("utf8")
    .replace(/=\r?\n/g, "");
};
const tokenIn = (mime: string) =>
  mime.match(/\/set-password\/([A-Za-z0-9_-]{43})/)?.[1] ?? "";

const parkRealJobs = (trx: Kysely<DB>) =>
  trx
    .updateTable("jobs")
    .set({ status: "failed" })
    .where("status", "in", ["pending", "running"])
    .execute();

// An active learner with an Authentik pk who still needs a password.
async function pendingLearner(
  trx: Transaction<DB>,
  over: Parameters<typeof makeUser>[1] = {},
) {
  await parkRealJobs(trx);
  return makeUser(trx, {
    name: "Priya Raman",
    email: `Priya-${crypto.randomUUID().slice(0, 6)}@Acme.com`,
    timezone: "America/New_York",
    authentik_user_pk: 900_000 + Math.floor(Math.random() * 99_999),
    set_password_pending: true,
    ...over,
  });
}

const run = (
  trx: Transaction<DB>,
  google: ReturnType<typeof gmail>,
  cfg: GoogleMailConfig = config(),
) =>
  runJobs(asConn(trx), {
    handlers: HANDLERS,
    config: async () => cfg,
    fetch: google.fetch,
    mint,
  });

const welcomeRows = (trx: Kysely<DB>, userId: string) =>
  trx
    .selectFrom("email_messages")
    .selectAll()
    .where("user_id", "=", userId)
    .where("kind", "=", "welcome")
    .orderBy("created_at")
    .execute();

const linkRows = (trx: Kysely<DB>, userId: string) =>
  trx
    .selectFrom("set_password_links")
    .selectAll()
    .where("user_id", "=", userId)
    .execute();

const jobOf = (trx: Kysely<DB>, key: string) =>
  trx
    .selectFrom("jobs")
    .select(["status", "attempts", "last_error"])
    .where("idempotency_key", "=", key)
    .executeTakeFirstOrThrow();

afterAll(() => (hasDb ? db().destroy() : undefined));
afterEach(() => vi.restoreAllMocks());

describe.skipIf(!hasDb)("send_welcome (spec 0014 AC-1 to AC-8)", () => {
  it("sends one email with a new live link and records the row and the hash (AC-1, AC-4, AC-6, AC-8)", () =>
    inRollback(async (trx) => {
      const user = await pendingLearner(trx);
      await enqueueWelcome(trx, user.id, welcomeKey(user.id), APP);
      const google = accepted();
      const step = await run(trx, google);
      expect(step).toMatchObject({ kind: "ran", ran: 1, failed: [] });

      const [req] = google.requests;
      expect(google.requests).toHaveLength(1);
      expect(req?.url).toContain("/messages/send");
      const mime = decoded(req);
      const token = tokenIn(mime);
      expect(token).toHaveLength(43);
      expect(mime).toContain(`${APP}/set-password/${token}`);
      // Nodemailer lowercases the domain.
      expect(mime.toLowerCase()).toContain(`to: ${user.email.toLowerCase()}`);
      // AC-5: never the Ops BCC, though the key has one.
      expect(mime).not.toMatch(/^Bcc:/m);
      expect(mime).toContain(
        "Subject: Set your password for Nile Hands-On Labs",
      );

      const [row] = await welcomeRows(trx, user.id);
      const now = (await sql<{ now: Date }>`select now() as now`.execute(trx))
        .rows[0]?.now;
      expect(row).toMatchObject({
        kind: "welcome",
        status: "sent",
        to_address: user.email,
        sent_to: user.email,
        subject: "Set your password for Nile Hands-On Labs",
        provider_message_id: "gmail-welcome-1",
        booking_id: null,
        booking_version: null,
        last_error: null,
      });
      expect(row?.sent_at).not.toBeNull();
      expect(mime).toContain(`Message-ID: <${row?.id}@nile-hol-reservations>`);
      // AC-8: the name, the expiry, and the zone, nothing else.
      expect(row?.details).toEqual({
        name: "Priya Raman",
        expiresAt: new Date(
          (now?.getTime() ?? 0) + 72 * 3_600_000,
        ).toISOString(),
        timeZone: "America/New_York",
      });

      const [link] = await linkRows(trx, user.id);
      expect(link).toMatchObject({
        email_message_id: row?.id,
        email: user.email.toLowerCase(),
        ended_at: null,
        ended_reason: null,
      });
      expect(link?.token_hash).toEqual(
        createHash("sha256").update(token).digest(),
      );
      expect(link?.expires_at.getTime()).toBe(
        (now?.getTime() ?? 0) + 72 * 3_600_000,
      );
      expect(await linkState(trx, token)).toMatchObject({ view: "live" });
    }));

  it.each([
    ["an admin", { role: "admin" }],
    [
      "a deactivated learner",
      { status: "deactivated", deactivated_at: new Date() },
    ],
    ["a learner with no Authentik pk", { authentik_user_pk: null }],
    ["a learner who set a password", { set_password_pending: false }],
  ] as const)("skips %s with no row and no link (AC-1)", (_who, over) =>
    inRollback(async (trx) => {
      const user = await pendingLearner(trx, over);
      await enqueueWelcome(trx, user.id, welcomeKey(user.id), APP);
      const google = accepted();
      await run(trx, google);
      expect(google.requests).toEqual([]);
      expect(await welcomeRows(trx, user.id)).toEqual([]);
      expect(await linkRows(trx, user.id)).toEqual([]);
      expect(await jobOf(trx, welcomeKey(user.id))).toMatchObject({
        status: "done",
      });
    }),
  );

  it("finishes a job queued before spec 0014 (no appUrl) with no row (AC-2)", () =>
    inRollback(async (trx) => {
      const user = await pendingLearner(trx);
      await trx
        .insertInto("jobs")
        .values({
          kind: "send_welcome",
          payload: JSON.stringify({ userId: user.id }),
          idempotency_key: welcomeKey(user.id),
        })
        .execute();
      const google = accepted();
      await run(trx, google);
      expect(google.requests).toEqual([]);
      expect(await welcomeRows(trx, user.id)).toEqual([]);
      expect(await jobOf(trx, welcomeKey(user.id))).toMatchObject({
        status: "done",
      });
    }));

  it("suppresses a job queued over 72 hours ago, with the console reason and no link (AC-2)", () =>
    inRollback(async (trx) => {
      const user = await pendingLearner(trx);
      await enqueueWelcome(trx, user.id, welcomeKey(user.id), APP);
      await trx
        .updateTable("jobs")
        .set({ created_at: sql<Date>`now() - interval '72 hours 1 minute'` })
        .where("idempotency_key", "=", welcomeKey(user.id))
        .execute();
      const google = accepted();
      await run(trx, google);
      expect(google.requests).toEqual([]);
      const rows = await welcomeRows(trx, user.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        status: "suppressed",
        last_error: STALE_WELCOME,
        sent_to: null,
      });
      expect(STALE_WELCOME).toBe(
        "Not sent: queued over 72 hours ago. Resend from the user page.",
      );
      expect(await linkRows(trx, user.id)).toEqual([]);
    }));

  it("still sends a job queued just under 72 hours ago", () =>
    inRollback(async (trx) => {
      const user = await pendingLearner(trx);
      await enqueueWelcome(trx, user.id, welcomeKey(user.id), APP);
      await trx
        .updateTable("jobs")
        .set({ created_at: sql<Date>`now() - interval '71 hours 59 minutes'` })
        .where("idempotency_key", "=", welcomeKey(user.id))
        .execute();
      const google = accepted();
      await run(trx, google);
      expect(google.requests).toHaveLength(1);
    }));

  it("reroutes a test address to the dev inbox with [dev] and no Bcc (AC-5)", () =>
    inRollback(async (trx) => {
      const user = await pendingLearner(trx, {
        email: `hol-test-${crypto.randomUUID().slice(0, 6)}@example.test`,
      });
      await enqueueWelcome(trx, user.id, welcomeKey(user.id), APP);
      const google = accepted();
      await run(trx, google);
      const mime = decoded(google.requests[0]);
      expect(mime).toContain("To: dev-inbox@nile.example");
      expect(mime).toContain(
        "Subject: [dev] Set your password for Nile Hands-On Labs",
      );
      expect(mime).not.toMatch(/^Bcc:/m);
      // The body still names the learner's own address.
      expect(mime).toContain(user.email);
      const [row] = await welcomeRows(trx, user.id);
      expect(row).toMatchObject({
        status: "sent",
        to_address: user.email,
        sent_to: "dev-inbox@nile.example",
        // As stored, with no prefix (AC-6).
        subject: "Set your password for Nile Hands-On Labs",
      });
    }));

  it("suppresses a test address once when no dev inbox is set, and a second job adds nothing (AC-3, AC-5)", () =>
    inRollback(async (trx) => {
      const user = await pendingLearner(trx, {
        email: `dev-${crypto.randomUUID().slice(0, 6)}@example.test`,
      });
      await enqueueWelcome(trx, user.id, welcomeKey(user.id), APP);
      await enqueueWelcome(trx, user.id, resendKey(user.id, new Date()), APP);
      const google = accepted();
      await run(trx, google, config({ devInbox: null }));
      expect(google.requests).toEqual([]);
      const rows = await welcomeRows(trx, user.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        status: "suppressed",
        last_error: SUPPRESSED_NO_DEV_INBOX,
      });
      expect(await linkRows(trx, user.id)).toEqual([]);
    }));

  it("writes nothing on a Gmail retry, and the job waits (AC-6)", () =>
    inRollback(async (trx) => {
      const user = await pendingLearner(trx);
      await enqueueWelcome(trx, user.id, welcomeKey(user.id), APP);
      const google = gmail(() => ({ status: 503 }));
      await run(trx, google);
      expect(await welcomeRows(trx, user.id)).toEqual([]);
      expect(await linkRows(trx, user.id)).toEqual([]);
      expect(await jobOf(trx, welcomeKey(user.id))).toMatchObject({
        status: "pending",
        last_error: GMAIL_RETRY,
      });
    }));

  it("writes nothing when Google rejects the credential (the breaker, AC-6)", () =>
    inRollback(async (trx) => {
      const user = await pendingLearner(trx);
      await enqueueWelcome(trx, user.id, welcomeKey(user.id), APP);
      const google = gmail(() => ({ status: 401 }));
      const step = await run(trx, google);
      expect(step).toMatchObject({ breaker: true });
      expect(await welcomeRows(trx, user.id)).toEqual([]);
      expect(await linkRows(trx, user.id)).toEqual([]);
      expect(await jobOf(trx, welcomeKey(user.id))).toMatchObject({
        status: "pending",
        attempts: 0,
      });
    }));

  it("writes one failed row and no link when Gmail refuses for good (AC-6)", () =>
    inRollback(async (trx) => {
      const user = await pendingLearner(trx);
      await enqueueWelcome(trx, user.id, welcomeKey(user.id), APP);
      const google = gmail(() => ({ status: 400 }));
      await run(trx, google);
      const rows = await welcomeRows(trx, user.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        status: "failed",
        last_error: "Gmail refused the message (400).",
        sent_to: null,
      });
      expect(await linkRows(trx, user.id)).toEqual([]);
      expect(await jobOf(trx, welcomeKey(user.id))).toMatchObject({
        status: "failed",
      });
    }));

  it("sends an unsent original plus an email change once, to the new address (AC-3)", () =>
    inRollback(async (trx) => {
      const user = await pendingLearner(trx);
      await enqueueWelcome(trx, user.id, welcomeKey(user.id), APP);
      const fixed = `fixed-${crypto.randomUUID().slice(0, 6)}@acme.com`;
      await trx
        .updateTable("users")
        .set({ email: fixed })
        .where("id", "=", user.id)
        .execute();
      await enqueueWelcome(
        trx,
        user.id,
        emailChangeKey(user.id, fixed, new Date()),
        APP,
      );
      const google = accepted();
      await run(trx, google);
      expect(google.requests).toHaveLength(1);
      expect(decoded(google.requests[0])).toContain(`To: ${fixed}`);
      expect(await welcomeRows(trx, user.id)).toHaveLength(1);
    }));

  it("sends a resend queued after an earlier send (AC-3)", () =>
    inRollback(async (trx) => {
      const user = await pendingLearner(trx);
      await enqueueWelcome(trx, user.id, welcomeKey(user.id), APP);
      const google = accepted();
      await run(trx, google);
      const later = resendKey(user.id, new Date());
      await enqueueWelcome(trx, user.id, later, APP);
      // now() is fixed in a test transaction; the resend came later.
      await trx
        .updateTable("jobs")
        .set({ created_at: sql<Date>`now() + interval '1 second'` })
        .where("idempotency_key", "=", later)
        .execute();
      await run(trx, google);
      expect(google.requests).toHaveLength(2);
      const tokens = google.requests.map((r) => tokenIn(decoded(r)));
      expect(new Set(tokens).size).toBe(2);
      expect(await welcomeRows(trx, user.id)).toHaveLength(2);
      // AC-13: either link works until one is clicked.
      for (const t of tokens)
        expect(await linkState(trx, t)).toMatchObject({ view: "live" });
    }));

  it("never writes the token or the link to a row, the payload, an audit row, or a log (AC-4, AC-18)", () =>
    inRollback(async (trx) => {
      const lines: string[] = [];
      for (const level of ["log", "info", "warn", "error"] as const)
        vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
          lines.push(args.map(String).join(" "));
        });
      const user = await pendingLearner(trx);
      await enqueueWelcome(trx, user.id, welcomeKey(user.id), APP);
      // A Gmail retry first, so a stored error is scanned too.
      let n = 0;
      const google = gmail(() =>
        n++ === 0
          ? { status: 503 }
          : { status: 200, json: { id: "gmail-welcome-2" } },
      );
      await run(trx, google);
      await trx
        .updateTable("jobs")
        .set({ run_at: sql<Date>`now()` })
        .where("idempotency_key", "=", welcomeKey(user.id))
        .execute();
      await run(trx, google);
      const token = tokenIn(decoded(google.requests[1]));
      expect(token).toHaveLength(43);

      const stored = JSON.stringify([
        await welcomeRows(trx, user.id),
        await trx
          .selectFrom("jobs")
          .selectAll()
          .where("payload", "@>", JSON.stringify({ userId: user.id }))
          .execute(),
        await trx
          .selectFrom("audit_events")
          .selectAll()
          .where("target_id", "=", user.id)
          .execute(),
        lines,
      ]);
      expect(stored).not.toContain(token);
      expect(stored).not.toContain("/set-password/");
    }));
});

describe("emailChangeKey (spec 0014 AC-14)", () => {
  it("keeps a second fix to the same address apart from the first", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const first = emailChangeKey(id, "Y@Acme.com", new Date(1_000));
    const again = emailChangeKey(id, "y@acme.com", new Date(9_000));
    expect(first).toBe(`welcome:${id}:email:y@acme.com:1000`);
    expect(again).not.toBe(first);
  });
});
