import type { Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import type { LearnerInput } from "@/lib/learner-input";
import {
  ADMINS,
  fakeAuthentik,
  fakeLearner,
  fakeUser,
} from "@/server/authentik/testing";
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
  createLearner,
  resendSetPasswordByAdmin,
  updateLearner,
} from "./learners";

const unique = () => crypto.randomUUID().slice(0, 8);
const input = (over: Partial<LearnerInput> = {}): LearnerInput => ({
  name: "Priya Shah",
  company: "Concordia University",
  email: `priya-${unique()}@x.test`,
  timezone: "America/Toronto",
  ...over,
});

const rowOf = (trx: Kysely<DB>, email: string) =>
  trx
    .selectFrom("users")
    .selectAll()
    .where("email", "=", email)
    .executeTakeFirst();

const jobsOf = (trx: Kysely<DB>, id: string) =>
  trx
    .selectFrom("jobs")
    .select("idempotency_key")
    .where("idempotency_key", "like", `welcome:${id}%`)
    .execute();

const auditsOf = (trx: Kysely<DB>, id: string) =>
  trx
    .selectFrom("audit_events")
    .select(["action", "metadata", "actor_user_id"])
    .where("target_id", "=", id)
    .execute();

// covers: AC-4, AC-5, AC-13
describe.skipIf(!hasDb)("createLearner, the add saga (spec 0008)", () => {
  it("creates the Authentik user, flags the password, queues the welcome, and audits", () =>
    inRollback(async (trx) => {
      const admin = await makeUser(trx, { role: "admin" });
      const ak = fakeAuthentik([]);
      const values = input();
      const r = await createLearner(ak.api, asConn(trx), values, admin.id);
      expect(r.ok).toBe(true);
      const row = await rowOf(trx, values.email);
      expect(row).toMatchObject({
        role: "learner",
        name: "Priya Shah",
        company: "Concordia University",
        timezone: "America/Toronto",
        authentik_user_pk: 100,
        set_password_pending: true,
      });
      expect(ak.users[0]?.attributes).toMatchObject({ hol_user_id: row?.id });
      expect(await jobsOf(trx, row?.id ?? "")).toEqual([
        { idempotency_key: `welcome:${row?.id}` },
      ]);
      const audits = await auditsOf(trx, row?.id ?? "");
      expect(audits.map((a) => a.action).sort()).toEqual([
        "user.created",
        "user.created_in_authentik",
      ]);
      expect(audits.every((a) => a.actor_user_id === admin.id)).toBe(true);
      expect(audits.find((a) => a.action === "user.created")?.metadata).toEqual(
        { reusedAuthentikUser: false },
      );
    }));

  it("reuses an account that signed in before, with no flag and no job", () =>
    inRollback(async (trx) => {
      const admin = await makeUser(trx, { role: "admin" });
      const values = input();
      const ak = fakeAuthentik([
        fakeLearner(9, {
          email: values.email,
          username: values.email,
          last_login: "2026-10-01T09:00:00Z",
        }),
      ]);
      const r = await createLearner(ak.api, asConn(trx), values, admin.id);
      expect(r.ok).toBe(true);
      const row = await rowOf(trx, values.email);
      expect(row).toMatchObject({
        authentik_user_pk: 9,
        set_password_pending: false,
      });
      expect(await jobsOf(trx, row?.id ?? "")).toEqual([]);
      expect(ak.writes).toEqual(["PATCH /core/users/9/"]); // the tag only
    }));

  it("treats a reused account that never signed in like a new one", () =>
    inRollback(async (trx) => {
      const admin = await makeUser(trx, { role: "admin" });
      const values = input();
      const ak = fakeAuthentik([
        fakeLearner(9, { email: values.email, username: values.email }),
      ]);
      await createLearner(ak.api, asConn(trx), values, admin.id);
      const row = await rowOf(trx, values.email);
      expect(row?.set_password_pending).toBe(true);
      expect(await jobsOf(trx, row?.id ?? "")).toHaveLength(1);
    }));

  it("returns the existing learner for a known email, ignoring case", () =>
    inRollback(async (trx) => {
      const admin = await makeUser(trx, { role: "admin" });
      const existing = await makeUser(trx, {
        email: `known-${unique()}@x.test`,
        authentik_user_pk: 5,
        status: "deactivated",
        deactivated_at: new Date(),
      });
      const ak = fakeAuthentik([]);
      const r = await createLearner(
        ak.api,
        asConn(trx),
        input({ email: existing.email.toUpperCase() }),
        admin.id,
      );
      expect(r).toEqual({
        ok: false,
        error: { kind: "duplicate", id: existing.id },
      });
      expect(ak.writes).toEqual([]);
    }));

  it("says a row with no pk yet is being set up", () =>
    inRollback(async (trx) => {
      const admin = await makeUser(trx, { role: "admin" });
      const pending = await makeUser(trx);
      const r = await createLearner(
        fakeAuthentik([]).api,
        asConn(trx),
        input({ email: pending.email }),
        admin.id,
      );
      expect(r).toEqual({ ok: false, error: "setting_up" });
    }));

  it("refuses an admin email, in the app or in Authentik, leaving no row", () =>
    inRollback(async (trx) => {
      const admin = await makeUser(trx, { role: "admin" });
      const appAdmin = await createLearner(
        fakeAuthentik([]).api,
        asConn(trx),
        input({ email: admin.email }),
        admin.id,
      );
      expect(appAdmin).toEqual({ ok: false, error: "admin_email" });

      const values = input();
      const ak = fakeAuthentik([
        fakeLearner(4, {
          email: values.email,
          username: values.email,
          groups: [ADMINS.pk],
        }),
      ]);
      const r = await createLearner(ak.api, asConn(trx), values, admin.id);
      expect(r).toEqual({ ok: false, error: "admin_email" });
      expect(await rowOf(trx, values.email)).toBeUndefined();
      expect(ak.writes).toEqual([]);
    }));

  it("maps Authentik refusals and leaves no row", () =>
    inRollback(async (trx) => {
      const admin = await makeUser(trx, { role: "admin" });
      const disabled = input();
      const r1 = await createLearner(
        fakeAuthentik([
          fakeLearner(4, {
            email: disabled.email,
            username: disabled.email,
            is_active: false,
          }),
        ]).api,
        asConn(trx),
        disabled,
        admin.id,
      );
      expect(r1).toEqual({ ok: false, error: "authentik_disabled" });

      const taken = input();
      const r2 = await createLearner(
        fakeAuthentik([
          fakeLearner(4, { email: "other@x.test", username: taken.email }),
        ]).api,
        asConn(trx),
        taken,
        admin.id,
      );
      expect(r2).toEqual({ ok: false, error: "authentik_conflict" });

      const down = input();
      const r3 = await createLearner(
        fakeAuthentik([], { down: true }).api,
        asConn(trx),
        down,
        admin.id,
      );
      expect(r3).toEqual({ ok: false, error: "unavailable" });

      for (const v of [disabled, taken, down])
        expect(await rowOf(trx, v.email)).toBeUndefined();
    }));

  it("undoes the row and the Authentik user it created when the last step fails", () =>
    inRollback(async (trx) => {
      const values = input();
      const ak = fakeAuthentik([]);
      // An actor id that is no user makes the audit insert fail.
      const r = await createLearner(
        ak.api,
        asConn(trx),
        values,
        crypto.randomUUID(),
      );
      expect(r).toEqual({ ok: false, error: "unavailable" });
      expect(await rowOf(trx, values.email)).toBeUndefined();
      expect(ak.writes).toEqual([
        "POST /core/users/",
        "DELETE /core/users/100/",
      ]);
    }));

  it("keeps a row a guest booking picked up, and its Authentik user", () =>
    inRollback(async (trx) => {
      const values = input();
      const ak = fakeAuthentik([]);
      const type = await makeType(trx);
      const testbed = await makeTestbed(trx, type.id);
      // The guest booking lands between the insert and the final step.
      const conn = asConn(trx);
      const api = ak.api;
      const original = api.coreUsersCreate.bind(api);
      api.coreUsersCreate = async (...args) => {
        const row = await rowOf(trx, values.email);
        await trx
          .insertInto("bookings")
          .values({
            user_id: row?.id ?? "",
            testbed_id: testbed.id,
            testbed_type_id: type.id,
            starts_at: slot(30),
            ends_at: slot(32),
            status: "provisioning",
          })
          .execute();
        return original(...args);
      };
      const r = await createLearner(api, conn, values, crypto.randomUUID());
      expect(r).toEqual({ ok: false, error: "unavailable" });
      expect(await rowOf(trx, values.email)).toBeDefined();
      expect(ak.writes).toEqual(["POST /core/users/"]);
    }));
});

// A learner row linked to Authentik user `pk`, with its fake account.
async function linked(
  trx: Kysely<DB>,
  pk: number,
  over: Parameters<typeof makeUser>[1] = {},
) {
  const email = `pat-${unique()}@x.test`;
  const row = await makeUser(trx, {
    name: "Pat Lee",
    company: "Acme",
    email,
    timezone: "UTC",
    authentik_user_pk: pk,
    set_password_pending: true,
    ...over,
  });
  return { row, account: fakeLearner(pk, { email, username: email }) };
}

const asInput = (
  row: {
    name: string;
    company: string | null;
    email: string;
    timezone: string;
  },
  over: Partial<LearnerInput> = {},
): LearnerInput => ({
  name: row.name,
  company: row.company ?? "",
  email: row.email,
  timezone: row.timezone,
  ...over,
});

const reread = (trx: Kysely<DB>, id: string) =>
  trx
    .selectFrom("users")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirstOrThrow();

// covers: AC-6, AC-13
describe.skipIf(!hasDb)("updateLearner, lock first (spec 0008 AC-6)", () => {
  it("syncs a name change to Authentik and audits it", () =>
    inRollback(async (trx) => {
      const admin = await makeUser(trx, { role: "admin" });
      const { row, account } = await linked(trx, 11);
      const ak = fakeAuthentik([account]);
      const r = await updateLearner(
        ak.api,
        asConn(trx),
        row.id,
        asInput(row, { name: "Pat Morgan" }),
        admin.id,
      );
      expect(r.ok).toBe(true);
      expect(ak.writes).toEqual(["PATCH /core/users/11/"]);
      expect(ak.users[0]?.name).toBe("Pat Morgan");
      expect((await reread(trx, row.id)).name).toBe("Pat Morgan");
      const [audit] = await auditsOf(trx, row.id);
      expect(audit).toMatchObject({
        action: "user.updated",
        actor_user_id: admin.id,
        metadata: {
          name: { from: "Pat Lee", to: "Pat Morgan" },
          authentikSynced: true,
        },
      });
    }));

  it("changes email and username while the password is pending, and queues a welcome", () =>
    inRollback(async (trx) => {
      const admin = await makeUser(trx, { role: "admin" });
      const { row, account } = await linked(trx, 11);
      const ak = fakeAuthentik([account]);
      const email = `Fixed-${unique()}@x.test`;
      const r = await updateLearner(
        ak.api,
        asConn(trx),
        row.id,
        asInput(row, { email }),
        admin.id,
      );
      expect(r.ok).toBe(true);
      expect(ak.users[0]).toMatchObject({
        email,
        username: email.toLowerCase(),
      });
      expect((await reread(trx, row.id)).email).toBe(email);
      expect(await jobsOf(trx, row.id)).toEqual([
        { idempotency_key: `welcome:${row.id}:email:${email.toLowerCase()}` },
      ]);
    }));

  it("allows a case only email change", () =>
    inRollback(async (trx) => {
      const admin = await makeUser(trx, { role: "admin" });
      const { row, account } = await linked(trx, 11);
      const ak = fakeAuthentik([account]);
      const r = await updateLearner(
        ak.api,
        asConn(trx),
        row.id,
        asInput(row, { email: row.email.toUpperCase() }),
        admin.id,
      );
      expect(r.ok).toBe(true);
      expect(ak.users[0]?.username).toBe(row.email);
    }));

  it("refuses an email change after sign in, with no Authentik write", () =>
    inRollback(async (trx) => {
      const admin = await makeUser(trx, { role: "admin" });
      const { row, account } = await linked(trx, 11, {
        set_password_pending: false,
      });
      const ak = fakeAuthentik([account]);
      const r = await updateLearner(
        ak.api,
        asConn(trx),
        row.id,
        asInput(row, { email: `new-${unique()}@x.test`, name: "Pat Morgan" }),
        admin.id,
      );
      expect(r).toEqual({ ok: false, error: "email_locked" });
      expect(ak.writes).toEqual([]);
      expect((await reread(trx, row.id)).name).toBe("Pat Lee");
    }));

  it("refuses an email another row or Authentik user holds", () =>
    inRollback(async (trx) => {
      const admin = await makeUser(trx, { role: "admin" });
      const { row, account } = await linked(trx, 11);
      const other = await makeUser(trx, { authentik_user_pk: 12 });
      const ak = fakeAuthentik([
        account,
        fakeUser({ pk: 13, email: "taken@x.test", username: "taken@x.test" }),
      ]);
      expect(
        await updateLearner(
          ak.api,
          asConn(trx),
          row.id,
          asInput(row, { email: other.email }),
          admin.id,
        ),
      ).toEqual({ ok: false, error: { kind: "duplicate", id: other.id } });
      expect(
        await updateLearner(
          ak.api,
          asConn(trx),
          row.id,
          asInput(row, { email: "taken@x.test" }),
          admin.id,
        ),
      ).toEqual({ ok: false, error: "authentik_conflict" });
      expect(ak.writes).toEqual([]);
    }));

  it("makes no Authentik call for a company or timezone edit", () =>
    inRollback(async (trx) => {
      const admin = await makeUser(trx, { role: "admin" });
      const { row, account } = await linked(trx, 11);
      const ak = fakeAuthentik([account]);
      const r = await updateLearner(
        ak.api,
        asConn(trx),
        row.id,
        asInput(row, { company: "Globex", timezone: "Europe/Paris" }),
        admin.id,
      );
      expect(r.ok).toBe(true);
      expect(ak.writes).toEqual([]);
      const [audit] = await auditsOf(trx, row.id);
      expect(audit?.metadata).not.toHaveProperty("authentikSynced");
    }));

  it("writes nothing for a save with no change", () =>
    inRollback(async (trx) => {
      const admin = await makeUser(trx, { role: "admin" });
      const { row, account } = await linked(trx, 11);
      const ak = fakeAuthentik([account]);
      const r = await updateLearner(
        ak.api,
        asConn(trx),
        row.id,
        asInput(row),
        admin.id,
      );
      expect(r.ok).toBe(true);
      expect(ak.writes).toEqual([]);
      expect(await auditsOf(trx, row.id)).toEqual([]);
    }));

  it("leaves the row unchanged when Authentik is down or refuses", () =>
    inRollback(async (trx) => {
      const admin = await makeUser(trx, { role: "admin" });
      const { row, account } = await linked(trx, 11);
      const down = await updateLearner(
        fakeAuthentik([account], { down: true }).api,
        asConn(trx),
        row.id,
        asInput(row, { name: "Pat Morgan", company: "Globex" }),
        admin.id,
      );
      expect(down).toEqual({ ok: false, error: "unavailable" });
      const untagged = await updateLearner(
        fakeAuthentik([{ ...account, attributes: {} }]).api,
        asConn(trx),
        row.id,
        asInput(row, { name: "Pat Morgan" }),
        admin.id,
      );
      expect(untagged).toEqual({ ok: false, error: "refused" });
      expect(await reread(trx, row.id)).toMatchObject({
        name: "Pat Lee",
        company: "Acme",
      });
      expect(await auditsOf(trx, row.id)).toEqual([]);
    }));

  it("refuses an admin row or a row with no pk as not found", () =>
    inRollback(async (trx) => {
      const admin = await makeUser(trx, { role: "admin" });
      const unlinked = await makeUser(trx);
      const ak = fakeAuthentik([]);
      for (const target of [admin, unlinked])
        expect(
          await updateLearner(
            ak.api,
            asConn(trx),
            target.id,
            asInput(target, { name: "X Y" }),
            admin.id,
          ),
        ).toEqual({ ok: false, error: "not_found" });
    }));
});

// covers: AC-7
describe.skipIf(!hasDb)("resendSetPasswordByAdmin (spec 0008 AC-7)", () => {
  it("queues one job per hour for an eligible learner, and audits each ask", () =>
    inRollback(async (trx) => {
      const admin = await makeUser(trx, { role: "admin" });
      const { row } = await linked(trx, 11);
      expect(
        await resendSetPasswordByAdmin(asConn(trx), row.id, admin.id),
      ).toEqual({
        ok: true,
        value: { email: row.email },
      });
      await resendSetPasswordByAdmin(asConn(trx), row.id, admin.id);
      expect(await jobsOf(trx, row.id)).toHaveLength(1);
      expect((await auditsOf(trx, row.id)).map((a) => a.action)).toEqual([
        "set_password.resent",
        "set_password.resent",
      ]);
    }));

  it("refuses a learner who set a password or is deactivated", () =>
    inRollback(async (trx) => {
      const admin = await makeUser(trx, { role: "admin" });
      const done = await linked(trx, 11, { set_password_pending: false });
      const off = await linked(trx, 12, {
        status: "deactivated",
        deactivated_at: new Date(),
      });
      for (const { row } of [done, off])
        expect(
          await resendSetPasswordByAdmin(asConn(trx), row.id, admin.id),
        ).toEqual({ ok: false, error: "not_eligible" });
      expect(await jobsOf(trx, done.row.id)).toEqual([]);
    }));
});
