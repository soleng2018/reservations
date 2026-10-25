import { sql, type Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import {
  ADMINS,
  fakeAuthentik,
  fakeLearner,
  fakeUser,
} from "@/server/authentik/testing";
import { hasDb, inRollback, makeUser } from "@/server/db/testing";
import type { DB } from "@/server/db/types";
import { ensureNileLogin, restoreNileLogin } from "./nile-login";

const DOMAIN = "nileworkshop-1.com";

async function learner(trx: Kysely<DB>, pk: number, name = "Ana Souza") {
  const row = await makeUser(trx, {
    name,
    email: `learner-${pk}@x.test`,
    authentik_user_pk: pk,
  });
  return {
    userId: row.id,
    pk,
    name,
    email: row.email,
    domain: DOMAIN,
  };
}

// Draws `first`, `first + 1`, ... (offsets from 1000).
const fixed = (first: number) => {
  let n = first;
  return () => n++;
};

const stored = (trx: Kysely<DB>, userId: string) =>
  trx
    .selectFrom("learner_domain_logins")
    .select(["domain", "username"])
    .where("user_id", "=", userId)
    .execute();

const audits = async (trx: Kysely<DB>, action: string) =>
  (
    await trx
      .selectFrom("audit_events")
      .select("metadata")
      .where("action", "=", action)
      .where("created_at", ">=", sql<Date>`now()`)
      .execute()
  ).map((r) => r.metadata);

// covers: AC-2, AC-3, AC-4, AC-5, AC-10, AC-11, AC-12
describe.skipIf(!hasDb)("ensureNileLogin", () => {
  it("sets username, mail, names; keeps email and other attributes", () =>
    inRollback(async (trx) => {
      const input = await learner(trx, 900_501);
      const ak = fakeAuthentik([
        fakeLearner(900_501, {
          email: input.email,
          attributes: { hol_learner: true, hol_user_id: "u" },
        }),
      ]);
      const r = await ensureNileLogin(ak.api, trx, input);
      expect(r).toMatchObject({
        ok: true,
        value: {
          username: `ana.souza@${DOMAIN}`,
          numbered: false,
          changed: true,
        },
      });
      expect(ak.users[0]).toMatchObject({
        username: `ana.souza@${DOMAIN}`,
        email: input.email,
        attributes: {
          hol_learner: true,
          hol_user_id: "u",
          mail: `ana.souza@${DOMAIN}`,
          firstName: "Ana",
          lastName: "Souza",
        },
      });
      expect(await stored(trx, input.userId)).toEqual([
        { domain: DOMAIN, username: `ana.souza@${DOMAIN}` },
      ]);
      expect(await audits(trx, "user.nile_login_set")).toEqual([
        {
          domain: DOMAIN,
          username: `ana.souza@${DOMAIN}`,
          numbered: false,
          changed: true,
        },
      ]);
    }));

  it("adds a number when the plain login is another Authentik user's", () =>
    inRollback(async (trx) => {
      const input = await learner(trx, 900_502);
      const ak = fakeAuthentik([
        fakeLearner(900_502, { email: input.email }),
        fakeUser({ pk: 8, username: `ana.souza@${DOMAIN}` }),
      ]);
      const r = await ensureNileLogin(ak.api, trx, input, fixed(3821));
      expect(r).toMatchObject({
        ok: true,
        value: { username: `ana.souza4821@${DOMAIN}`, numbered: true },
      });
    }));

  it("adds a number when another learner stored the plain login", () =>
    inRollback(async (trx) => {
      const input = await learner(trx, 900_503);
      const other = await makeUser(trx);
      await trx
        .insertInto("learner_domain_logins")
        .values({
          user_id: other.id,
          domain: DOMAIN,
          username: `ana.souza@${DOMAIN}`,
          used_at: sql<Date>`now()`,
        })
        .execute();
      const ak = fakeAuthentik([fakeLearner(900_503, { email: input.email })]);
      const r = await ensureNileLogin(ak.api, trx, input, fixed(3821));
      expect(r).toMatchObject({
        ok: true,
        value: { username: `ana.souza4821@${DOMAIN}` },
      });
    }));

  it("refuses with unavailable when every candidate clashes", () =>
    inRollback(async (trx) => {
      const input = await learner(trx, 900_504);
      const taken = [undefined, 1000, 1001, 1002, 1003, 1004].map((n, i) =>
        fakeUser({
          pk: 20 + i,
          username: `ana.souza${n ?? ""}@${DOMAIN}`,
        }),
      );
      const ak = fakeAuthentik([
        fakeLearner(900_504, { email: input.email }),
        ...taken,
      ]);
      // Three attempts of five draws, none free: the draws are the same run.
      const r = await ensureNileLogin(
        ak.api,
        trx,
        input,
        (() => {
          let i = 0;
          return () => i++ % 5;
        })(),
      );
      expect(r).toEqual({ ok: false, error: "unavailable" });
      expect(ak.writes).toEqual([]);
    }));

  it("returns at once when this domain is already the latest in use", () =>
    inRollback(async (trx) => {
      const input = await learner(trx, 900_505);
      const ak = fakeAuthentik([fakeLearner(900_505, { email: input.email })]);
      await ensureNileLogin(ak.api, trx, input);
      ak.writes.length = 0;
      const again = await ensureNileLogin(ak.api, trx, input);
      expect(again).toMatchObject({ ok: true, value: { changed: false } });
      expect(ak.writes).toEqual([]);
      expect(await audits(trx, "user.nile_login_set")).toHaveLength(1);
    }));

  it("reuses the stored login for an old domain even when the plain one is taken", () =>
    inRollback(async (trx) => {
      const input = await learner(trx, 900_506);
      const ak = fakeAuthentik([fakeLearner(900_506, { email: input.email })]);
      await ensureNileLogin(ak.api, trx, input);
      // A second domain makes it the latest, and backdates the first.
      await trx
        .updateTable("learner_domain_logins")
        .set({ used_at: sql<Date>`now() - interval '1 day'` })
        .execute();
      await ensureNileLogin(ak.api, trx, { ...input, domain: "nile.global" });
      expect(ak.users[0]?.username).toBe("ana.souza@nile.global");
      // Someone else could now take the plain address in the first domain.
      await trx
        .updateTable("learner_domain_logins")
        .set({ used_at: sql<Date>`now() - interval '2 days'` })
        .where("domain", "=", DOMAIN)
        .execute();
      const back = await ensureNileLogin(ak.api, trx, input);
      expect(back).toMatchObject({
        ok: true,
        value: { username: `ana.souza@${DOMAIN}`, changed: true },
      });
      expect(ak.users[0]?.username).toBe(`ana.souza@${DOMAIN}`);
      expect(await stored(trx, input.userId)).toHaveLength(2);
    }));

  it("refuses a stored login another user holds now, without redrawing", () =>
    inRollback(async (trx) => {
      const input = await learner(trx, 900_507);
      const ak = fakeAuthentik([fakeLearner(900_507, { email: input.email })]);
      await ensureNileLogin(ak.api, trx, input);
      await trx
        .updateTable("learner_domain_logins")
        .set({ used_at: sql<Date>`now() - interval '1 day'` })
        .execute();
      await ensureNileLogin(ak.api, trx, { ...input, domain: "nile.global" });
      ak.users.push(
        fakeUser({ pk: 9, username: `ana.souza@${DOMAIN}` }) as never,
      );
      await trx
        .updateTable("learner_domain_logins")
        .set({ used_at: sql<Date>`now() - interval '2 days'` })
        .where("domain", "=", DOMAIN)
        .execute();
      const r = await ensureNileLogin(ak.api, trx, input);
      expect(r).toEqual({
        ok: false,
        error: { taken: { domain: DOMAIN, username: `ana.souza@${DOMAIN}` } },
      });
    }));

  it("refuses admins and untagged users before any write", () =>
    inRollback(async (trx) => {
      const admin = await learner(trx, 900_508);
      const untagged = await learner(trx, 900_509);
      const ak = fakeAuthentik([
        fakeUser({
          pk: 900_508,
          groups: [ADMINS.pk],
          attributes: { hol_learner: true },
        }),
        fakeUser({ pk: 900_509 }),
      ]);
      expect(await ensureNileLogin(ak.api, trx, admin)).toEqual({
        ok: false,
        error: "refused",
      });
      expect(await ensureNileLogin(ak.api, trx, untagged)).toEqual({
        ok: false,
        error: "refused",
      });
      expect(ak.writes).toEqual([]);
      expect(await stored(trx, admin.userId)).toEqual([]);
    }));

  it("is unavailable when Authentik is down", () =>
    inRollback(async (trx) => {
      const input = await learner(trx, 900_510);
      const ak = fakeAuthentik([], { down: true });
      expect(await ensureNileLogin(ak.api, trx, input)).toEqual({
        ok: false,
        error: "unavailable",
      });
    }));

  it("restoreNileLogin puts the previous username back", () =>
    inRollback(async (trx) => {
      const input = await learner(trx, 900_511);
      const ak = fakeAuthentik([
        fakeLearner(900_511, { username: input.email, email: input.email }),
      ]);
      const r = await ensureNileLogin(ak.api, trx, input);
      expect(r.ok && r.value.renamedFrom?.username).toBe(input.email);
      await restoreNileLogin(ak.api, r.ok ? r.value.renamedFrom : null);
      expect(ak.users[0]?.username).toBe(input.email);
    }));

  it("two learners with the same name never share a login (AC-10)", () =>
    inRollback(async (trx) => {
      const a = await learner(trx, 900_512);
      const b = await learner(trx, 900_513);
      const ak = fakeAuthentik([
        fakeLearner(900_512, { email: a.email }),
        fakeLearner(900_513, { email: b.email }),
      ]);
      const ra = await ensureNileLogin(ak.api, trx, a, fixed(1));
      const rb = await ensureNileLogin(ak.api, trx, b, fixed(2));
      expect(ra).toMatchObject({
        ok: true,
        value: { username: `ana.souza@${DOMAIN}` },
      });
      expect(rb).toMatchObject({
        ok: true,
        value: { username: `ana.souza1002@${DOMAIN}`, numbered: true },
      });
    }));
});
