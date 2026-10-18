import { sql, type Kysely, type Transaction } from "kysely";
import { afterAll, describe, expect, it } from "vitest";
import { fakeAuthentik, fakeLearner } from "@/server/authentik/testing";
import { db } from "@/server/db";
import { asConn, hasDb, inRollback, makeUser } from "@/server/db/testing";
import type { DB } from "@/server/db/types";
import { updateLearner } from "@/server/users/learners";
import {
  linkState,
  newToken,
  purgeSetPasswordLinks,
} from "./set-password-links";

// covers: spec 0014 AC-4, AC-14, AC-16 (revocation by an email change, the
// address backstop, and the purge).

async function sentLink(
  trx: Kysely<DB>,
  user: { readonly id: string; readonly email: string },
  over: { readonly email?: string; readonly expiresDaysAgo?: number } = {},
) {
  const { token, hash } = newToken();
  const email = await trx
    .insertInto("email_messages")
    .values({
      user_id: user.id,
      kind: "welcome",
      to_address: user.email,
      subject: "Set your password for Nile Hands-On Labs",
      details: JSON.stringify({ name: "Pat", expiresAt: "x", timeZone: "UTC" }),
      status: "sent",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const link = await trx
    .insertInto("set_password_links")
    .values({
      user_id: user.id,
      email_message_id: email.id,
      token_hash: hash,
      email: over.email ?? user.email.toLowerCase(),
      expires_at:
        over.expiresDaysAgo === undefined
          ? sql<Date>`now() + interval '72 hours'`
          : sql<Date>`now() - make_interval(days => ${over.expiresDaysAgo})`,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return { token, linkId: link.id };
}

async function pendingLearner(trx: Transaction<DB>) {
  const pk = 800_000 + Math.floor(Math.random() * 99_999);
  const user = await makeUser(trx, {
    email: `pat-${crypto.randomUUID().slice(0, 6)}@acme.com`,
    authentik_user_pk: pk,
    set_password_pending: true,
  });
  return { user, pk };
}

afterAll(() => (hasDb ? db().destroy() : undefined));

describe.skipIf(!hasDb)("set password links (spec 0014)", () => {
  it("stores only a 43 character token's sha256 (AC-4)", () => {
    const { token, hash } = newToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hash).toHaveLength(32);
    expect(hash.toString("utf8")).not.toContain(token);
  });

  it("ends every live link when an admin fixes the email, and the old token goes dead (AC-14)", () =>
    inRollback(async (trx) => {
      const admin = await makeUser(trx, { role: "admin" });
      const { user, pk } = await pendingLearner(trx);
      const first = await sentLink(trx, user);
      const second = await sentLink(trx, user);
      const ak = fakeAuthentik([fakeLearner(pk, { email: user.email })]);
      const fixed = `fixed-${crypto.randomUUID().slice(0, 6)}@acme.com`;
      const r = await updateLearner(
        ak.api,
        asConn(trx),
        user.id,
        {
          name: user.name,
          company: user.company ?? "Test Co",
          email: fixed,
          timezone: user.timezone,
        },
        admin.id,
      );
      expect(r.ok).toBe(true);
      const ended = await trx
        .selectFrom("set_password_links")
        .select("ended_reason")
        .where("user_id", "=", user.id)
        .execute();
      expect(ended).toEqual([
        { ended_reason: "email_changed" },
        { ended_reason: "email_changed" },
      ]);
      expect(await linkState(trx, first.token)).toEqual({ view: "dead" });
      expect(await linkState(trx, second.token)).toEqual({ view: "dead" });
    }));

  it("leaves links alone on an edit that keeps the email (AC-14)", () =>
    inRollback(async (trx) => {
      const admin = await makeUser(trx, { role: "admin" });
      const { user, pk } = await pendingLearner(trx);
      const { token } = await sentLink(trx, user);
      const ak = fakeAuthentik([fakeLearner(pk, { email: user.email })]);
      const r = await updateLearner(
        ak.api,
        asConn(trx),
        user.id,
        {
          name: "Pat Morgan",
          company: user.company ?? "Test Co",
          email: user.email,
          timezone: user.timezone,
        },
        admin.id,
      );
      expect(r.ok).toBe(true);
      expect(await linkState(trx, token)).toMatchObject({ view: "live" });
    }));

  it("treats a link for another address as dead, even unended (the AC-14 backstop)", () =>
    inRollback(async (trx) => {
      const { user } = await pendingLearner(trx);
      const { token } = await sentLink(trx, user, { email: "old@acme.com" });
      expect(await linkState(trx, token)).toEqual({ view: "dead" });
    }));

  it("purges links 30 days past expiry and keeps younger ones (AC-16)", () =>
    inRollback(async (trx) => {
      const { user } = await pendingLearner(trx);
      const old = await sentLink(trx, user, { expiresDaysAgo: 31 });
      const young = await sentLink(trx, user, { expiresDaysAgo: 29 });
      const live = await sentLink(trx, user);
      expect(await purgeSetPasswordLinks(trx)).toBeGreaterThanOrEqual(1);
      const left = await trx
        .selectFrom("set_password_links")
        .select("id")
        .where("user_id", "=", user.id)
        .execute();
      expect(left.map((l) => l.id).toSorted()).toEqual(
        [young.linkId, live.linkId].toSorted(),
      );
      expect(left.map((l) => l.id)).not.toContain(old.linkId);
    }));
});
