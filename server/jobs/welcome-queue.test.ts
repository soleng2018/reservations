import type { Kysely } from "kysely";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { hasDb, inRollback, makeUser } from "@/server/db/testing";
import type { DB } from "@/server/db/types";
import {
  enqueueWelcome,
  resendKey,
  sendWelcomePayload,
  welcomeKey,
} from "./welcome-queue";

// covers: spec 0014 AC-2, AC-15 (the queue side; the handler is in
// send-welcome.test.ts, emailChangeKey there too).

const ID = "11111111-1111-4111-8111-111111111111";
const APP = "http://10.1.255.18:3000";

afterAll(() => (hasDb ? db().destroy() : undefined));

describe("sendWelcomePayload (spec 0014 AC-2, AC-15)", () => {
  it("parses a payload with the queuing app's origin", () => {
    expect(sendWelcomePayload.parse({ userId: ID, appUrl: APP })).toEqual({
      userId: ID,
      appUrl: APP,
    });
  });

  it("still parses a job queued before spec 0014, with no appUrl (AC-2)", () => {
    expect(sendWelcomePayload.parse({ userId: ID })).toEqual({ userId: ID });
  });

  it.each([
    ["a user id that is not a uuid", { userId: "u-1", appUrl: APP }],
    ["an appUrl that is not a URL", { userId: ID, appUrl: "10.1.255.18" }],
    ["no user id", { appUrl: APP }],
  ])("refuses %s", (_, payload) => {
    expect(sendWelcomePayload.safeParse(payload).success).toBe(false);
  });
});

describe("welcome job keys (spec 0014 AC-15, unchanged)", () => {
  it("keys the saga's job once per user", () => {
    expect(welcomeKey(ID)).toBe(`welcome:${ID}`);
  });

  it("keys a resend by the UTC hour, so asks in one hour share a job", () => {
    const early = resendKey(ID, new Date("2026-10-18T07:00:00Z"));
    const late = resendKey(ID, new Date("2026-10-18T07:59:59.999Z"));
    expect(early).toBe(`welcome:${ID}:resend:2026-10-18T07`);
    expect(late).toBe(early);
  });

  it("gives the next hour's resend its own job", () => {
    expect(resendKey(ID, new Date("2026-10-18T08:00:00Z"))).not.toBe(
      resendKey(ID, new Date("2026-10-18T07:59:59Z")),
    );
  });
});

describe.skipIf(!hasDb)("enqueueWelcome (spec 0014 AC-15)", () => {
  const jobsOf = (trx: Kysely<DB>, key: string) =>
    trx
      .selectFrom("jobs")
      .select(["kind", "payload", "status"])
      .where("idempotency_key", "=", key)
      .execute();

  it("queues one send_welcome job carrying the user and the app's origin", () =>
    inRollback(async (trx) => {
      const user = await makeUser(trx, { set_password_pending: true });
      await enqueueWelcome(trx, user.id, welcomeKey(user.id), APP);
      const jobs = await jobsOf(trx, welcomeKey(user.id));
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.kind).toBe("send_welcome");
      expect(sendWelcomePayload.parse(jobs[0]?.payload)).toEqual({
        userId: user.id,
        appUrl: APP,
      });
    }));

  it("treats a repeat of the same key as a no op, keeping the first job", () =>
    inRollback(async (trx) => {
      const user = await makeUser(trx, { set_password_pending: true });
      const key = welcomeKey(user.id);
      await enqueueWelcome(trx, user.id, key, APP);
      await enqueueWelcome(trx, user.id, key, "https://other.example");
      const jobs = await jobsOf(trx, key);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.payload).toMatchObject({ appUrl: APP });
    }));
});
