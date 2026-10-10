import { describe, expect, it } from "vitest";
import {
  ADMINS,
  fakeAuthentik,
  fakeUser,
  type FakeUser,
} from "@/server/authentik/testing";
import { hasDb, inRollback, makeUser } from "@/server/db/testing";
import {
  enqueueWelcome,
  resendKey,
  runSendWelcome,
  welcomeKey,
  type SetPasswordEmail,
} from "./send-welcome";

const tagged = (over: Partial<FakeUser>) =>
  fakeUser({ attributes: { hol_learner: true }, ...over });

const outbox = () => {
  const sent: SetPasswordEmail[] = [];
  return {
    sent,
    send: async (e: SetPasswordEmail) => {
      sent.push(e);
    },
  };
};

describe("welcome job keys", () => {
  it("gives the saga one key per user, and a resend one per hour", () => {
    expect(welcomeKey("u1")).toBe("welcome:u1");
    const at = new Date("2026-10-08T14:59:00Z");
    expect(resendKey("u1", at)).toBe("welcome:u1:resend:2026-10-08T14");
    expect(resendKey("u1", new Date("2026-10-08T15:00:00Z"))).not.toBe(
      resendKey("u1", at),
    );
  });
});

// covers: AC-6, AC-8
describe.skipIf(!hasDb)("send_welcome job (AC-6)", () => {
  it("enqueues one job per idempotency key", () =>
    inRollback(async (trx) => {
      const u = await makeUser(trx);
      await enqueueWelcome(trx, u.id, welcomeKey(u.id));
      await enqueueWelcome(trx, u.id, welcomeKey(u.id));
      const jobs = await trx
        .selectFrom("jobs")
        .select(["kind", "payload"])
        .where("idempotency_key", "=", welcomeKey(u.id))
        .execute();
      expect(jobs).toEqual([
        { kind: "send_welcome", payload: { userId: u.id } },
      ]);
    }));

  it("asks Authentik for a 72 hour link when it sends", () =>
    inRollback(async (trx) => {
      const u = await makeUser(trx, {
        authentik_user_pk: 41,
        set_password_pending: true,
      });
      const ak = fakeAuthentik([tagged({ pk: 41 })]);
      const box = outbox();
      expect(
        await runSendWelcome(ak.api, trx, { userId: u.id }, box.send),
      ).toEqual({ ok: true, value: "sent" });
      expect(box.sent).toEqual([
        {
          to: u.email,
          name: u.name,
          link: "https://auth.test/recover/41?for=hours=72",
        },
      ]);
    }));

  it("skips a learner who already set a password, or is deactivated", () =>
    inRollback(async (trx) => {
      const done = await makeUser(trx, {
        authentik_user_pk: 41,
        set_password_pending: false,
      });
      const gone = await makeUser(trx, {
        authentik_user_pk: 42,
        set_password_pending: true,
        status: "deactivated",
        deactivated_at: new Date(),
      });
      const ak = fakeAuthentik([tagged({ pk: 41 }), tagged({ pk: 42 })]);
      const box = outbox();
      for (const id of [done.id, gone.id])
        expect(
          await runSendWelcome(ak.api, trx, { userId: id }, box.send),
        ).toEqual({ ok: true, value: "skipped" });
      expect(box.sent).toEqual([]);
      expect(ak.writes).toEqual([]);
    }));

  it("never sends to someone who became an admin in Authentik", () =>
    inRollback(async (trx) => {
      const u = await makeUser(trx, {
        authentik_user_pk: 41,
        set_password_pending: true,
      });
      const ak = fakeAuthentik([tagged({ pk: 41, groups: [ADMINS.pk] })]);
      const box = outbox();
      expect(
        await runSendWelcome(ak.api, trx, { userId: u.id }, box.send),
      ).toEqual({ ok: true, value: "skipped" });
      expect(box.sent).toEqual([]);
      expect(ak.writes).toEqual([]);
    }));

  it("asks for a retry when Authentik is down", () =>
    inRollback(async (trx) => {
      const u = await makeUser(trx, {
        authentik_user_pk: 41,
        set_password_pending: true,
      });
      const ak = fakeAuthentik([tagged({ pk: 41 })], { down: true });
      const box = outbox();
      expect(
        await runSendWelcome(ak.api, trx, { userId: u.id }, box.send),
      ).toEqual({ ok: false, error: "unavailable" });
      expect(box.sent).toEqual([]);
    }));
});
