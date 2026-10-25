import { sql, type Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import { formatDateTime } from "@/lib/format-time";
import type { LearnerInput } from "@/lib/learner-input";
import {
  ADMINS,
  FAKE_NEW_PK,
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
import { dbNow } from "@/server/db/bookings";
import type { DB } from "@/server/db/types";
import { appUrl } from "@/server/env";
import {
  cancelBookingByAdmin,
  createLearner,
  deactivationPreview,
  getLearnerDetail,
  isConsoleLearner,
  listLearnersForAdmin,
  nileLoginsForUser,
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
        authentik_user_pk: FAKE_NEW_PK,
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
        `DELETE /core/users/${FAKE_NEW_PK}/`,
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
      // Spec 0014 AC-14: the key carries the change's DB time (now() is
      // fixed for the whole test transaction).
      expect(await jobsOf(trx, row.id)).toEqual([
        {
          idempotency_key: `welcome:${row.id}:email:${email.toLowerCase()}:${(await dbNow(trx)).getTime()}`,
        },
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

async function bookingFor(
  trx: Kysely<DB>,
  userId: string,
  from: number,
  to: number,
  status = "confirmed",
) {
  const type = await makeType(trx);
  const testbed = await makeTestbed(trx, type.id);
  const row = await trx
    .insertInto("bookings")
    .values({
      user_id: userId,
      testbed_id: testbed.id,
      testbed_type_id: type.id,
      starts_at: slot(from),
      ends_at: slot(to),
      status,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return { row, testbed };
}

// covers: AC-10, AC-13
describe.skipIf(!hasDb)("cancelBookingByAdmin (spec 0008 AC-10)", () => {
  it.each([
    { phase: "Upcoming", from: 48, to: 50 },
    { phase: "Current", from: -1, to: 2 },
  ])(
    "cancels an $phase booking as the admin and audits it",
    ({ phase, from, to }) =>
      inRollback(async (trx) => {
        const admin = await makeUser(trx, { role: "admin" });
        const { row: learner } = await linked(trx, 11);
        const { row: b, testbed } = await bookingFor(trx, learner.id, from, to);
        expect(
          await cancelBookingByAdmin(asConn(trx), b.id, b.version, admin.id),
        ).toEqual({ ok: true, value: undefined });
        const after = await trx
          .selectFrom("bookings")
          .selectAll()
          .where("id", "=", b.id)
          .executeTakeFirstOrThrow();
        expect(after).toMatchObject({
          status: "cancelled",
          cancel_source: "admin",
          cancelled_by_user_id: admin.id,
        });
        expect(after.ends_at).toEqual(b.ends_at);
        const [audit] = await auditsOf(trx, b.id);
        expect(audit).toMatchObject({
          action: "booking.cancelled",
          actor_user_id: admin.id,
          metadata: {
            source: "admin",
            userId: learner.id,
            testbedId: testbed.id,
            phase,
          },
        });
      }),
  );

  it("returns stale for a wrong version, a Past booking, or a cancelled one", () =>
    inRollback(async (trx) => {
      const admin = await makeUser(trx, { role: "admin" });
      const { row: learner } = await linked(trx, 11);
      const { row: live } = await bookingFor(trx, learner.id, 48, 50);
      expect(
        await cancelBookingByAdmin(
          asConn(trx),
          live.id,
          live.version + 1,
          admin.id,
        ),
      ).toEqual({ ok: false, error: "stale" });
      await cancelBookingByAdmin(asConn(trx), live.id, live.version, admin.id);
      expect(
        await cancelBookingByAdmin(
          asConn(trx),
          live.id,
          live.version,
          admin.id,
        ),
      ).toEqual({ ok: false, error: "stale" });
      const { row: past } = await bookingFor(trx, learner.id, -10, -8);
      expect(
        await cancelBookingByAdmin(
          asConn(trx),
          past.id,
          past.version,
          admin.id,
        ),
      ).toEqual({ ok: false, error: "stale" });
      expect(await auditsOf(trx, past.id)).toEqual([]);
    }));
});

// covers: AC-8
describe.skipIf(!hasDb)("deactivationPreview (spec 0008 AC-8)", () => {
  it("lists only bookings that have not ended, labelled in the admin's zone", () =>
    inRollback(async (trx) => {
      const { row: learner } = await linked(trx, 11);
      const { row: live, testbed } = await bookingFor(trx, learner.id, -1, 2);
      await bookingFor(trx, learner.id, -10, -8, "completed");
      const preview = await deactivationPreview(trx, learner.id, "Asia/Tokyo");
      expect(preview).toEqual([
        {
          id: live.id,
          label: `${testbed.name} — Current reservation, ${formatDateTime(live.starts_at, "Asia/Tokyo")}`,
        },
      ]);
      const admin = await makeUser(trx, { role: "admin" });
      expect(await deactivationPreview(trx, admin.id, "UTC")).toEqual([]);
    }));
});

// A booking of `userId`, `from` to `to` hours from now, on its own testbed
// unless one is given; a cancelled one records its source.
async function bookingOf(
  trx: Kysely<DB>,
  userId: string,
  opts: {
    readonly from: number;
    readonly to: number;
    readonly status: string;
    readonly cancelSource?: "learner" | "admin" | "deactivation";
    readonly testbed?: {
      readonly id: string;
      readonly testbed_type_id: string;
    };
  },
) {
  const testbed =
    opts.testbed ?? (await makeTestbed(trx, (await makeType(trx)).id));
  return trx
    .insertInto("bookings")
    .values({
      user_id: userId,
      testbed_id: testbed.id,
      testbed_type_id: testbed.testbed_type_id,
      starts_at: slot(opts.from),
      ends_at: slot(opts.to),
      status: opts.status,
      ...(opts.cancelSource
        ? {
            cancelled_at: slot(opts.from - 24),
            cancel_source: opts.cancelSource,
          }
        : {}),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

// covers: AC-1
describe.skipIf(!hasDb)("listLearnersForAdmin (spec 0008 AC-1)", () => {
  // The shared database holds other rows, so look only at this test's.
  const mine = async (trx: Kysely<DB>, ids: readonly string[]) =>
    (await listLearnersForAdmin(trx)).filter((r) => ids.includes(r.id));

  it("lists learners with a pk, ordered by name ignoring case", () =>
    inRollback(async (trx) => {
      const tag = unique();
      const { row: zed } = await linked(trx, 9401, { name: `zed ${tag}` });
      const { row: amy } = await linked(trx, 9402, { name: `Amy ${tag}` });
      const { row: bob } = await linked(trx, 9403, {
        name: `bob ${tag}`,
        status: "deactivated",
        deactivated_at: new Date(),
      });
      const pending = await makeUser(trx, { name: `Al ${tag}` });
      const admin = await makeUser(trx, {
        name: `Ada ${tag}`,
        role: "admin",
        authentik_user_pk: 9404,
      });
      const ids = [zed.id, amy.id, bob.id, pending.id, admin.id];
      expect((await mine(trx, ids)).map((r) => r.id)).toEqual([
        amy.id,
        bob.id,
        zed.id,
      ]);
    }));

  it("carries the status and the edit defaults of each row", () =>
    inRollback(async (trx) => {
      const { row } = await linked(trx, 9401, {
        status: "deactivated",
        deactivated_at: new Date(),
        set_password_pending: false,
        company: null,
        timezone: "Asia/Tokyo",
      });
      expect(await mine(trx, [row.id])).toEqual([
        {
          id: row.id,
          name: "Pat Lee",
          company: null,
          email: row.email,
          timezone: "Asia/Tokyo",
          status: "deactivated",
          reservationCount: 0,
          emailEditable: false,
        },
      ]);
    }));

  it("counts every booking except cancelled and provisioning ones", () =>
    inRollback(async (trx) => {
      const { row: a } = await linked(trx, 9401);
      await bookingOf(trx, a.id, { from: -30, to: -28, status: "completed" });
      await bookingOf(trx, a.id, {
        from: -20,
        to: -18,
        status: "cancelled",
        cancelSource: "learner",
      });
      await bookingOf(trx, a.id, { from: 48, to: 50, status: "provisioning" });
      // A confirmed booking past its end the worker has not completed yet
      // shows as Past, so it counts.
      const { row: b } = await linked(trx, 9402);
      await bookingOf(trx, b.id, { from: -10, to: -8, status: "confirmed" });
      await bookingOf(trx, b.id, { from: -30, to: -28, status: "completed" });
      const counts = Object.fromEntries(
        (await mine(trx, [a.id, b.id])).map((r) => [r.id, r.reservationCount]),
      );
      expect(counts).toEqual({ [a.id]: 1, [b.id]: 2 });
    }));
});

// covers: AC-2
describe.skipIf(!hasDb)("getLearnerDetail (spec 0008 AC-2)", () => {
  it("lists every booking newest first with its phase and canceller", () =>
    inRollback(async (trx) => {
      const { row } = await linked(trx, 9401);
      const upcoming = await bookingOf(trx, row.id, {
        from: 48,
        to: 50,
        status: "confirmed",
      });
      const past = await bookingOf(trx, row.id, {
        from: -10,
        to: -8,
        status: "completed",
      });
      const cancelled = await bookingOf(trx, row.id, {
        from: -30,
        to: -28,
        status: "cancelled",
        cancelSource: "deactivation",
      });
      const found = await getLearnerDetail(trx, row.id);
      if (!found.ok) throw new Error("expected the learner");
      expect(
        found.value.bookings.map((b) => [b.id, b.phase, b.cancelSource]),
      ).toEqual([
        [upcoming.id, "Upcoming", null],
        [past.id, "Past", null],
        [cancelled.id, "Cancelled", "deactivation"],
      ]);
      expect(found.value.bookings[0]).toMatchObject({
        version: upcoming.version,
        startsAt: upcoming.starts_at,
        endsAt: upcoming.ends_at,
      });
    }));

  it("shows Current and Pending bookings by their phase", () =>
    inRollback(async (trx) => {
      const { row: a } = await linked(trx, 9401);
      await bookingOf(trx, a.id, { from: -1, to: 2, status: "confirmed" });
      const { row: b } = await linked(trx, 9402);
      await bookingOf(trx, b.id, { from: 48, to: 50, status: "provisioning" });
      const phases = async (id: string) => {
        const found = await getLearnerDetail(trx, id);
        return found.ok ? found.value.bookings.map((x) => x.phase) : [];
      };
      expect(await phases(a.id)).toEqual(["Current"]);
      expect(await phases(b.id)).toEqual(["Pending"]);
    }));

  it("names a soft deleted testbed and type", () =>
    inRollback(async (trx) => {
      const { row } = await linked(trx, 9401);
      const type = await makeType(trx, { deleted_at: new Date() });
      const testbed = await makeTestbed(trx, type.id, {
        deleted_at: new Date(),
      });
      await bookingOf(trx, row.id, {
        from: -30,
        to: -28,
        status: "cancelled",
        cancelSource: "admin",
        testbed,
      });
      const found = await getLearnerDetail(trx, row.id);
      if (!found.ok) throw new Error("expected the learner");
      expect(found.value.bookings).toMatchObject([
        { testbedName: testbed.name, typeName: type.name },
      ]);
    }));

  it("returns the learner's header values and counts like the list", () =>
    inRollback(async (trx) => {
      const { row } = await linked(trx, 9401, { set_password_pending: true });
      await bookingOf(trx, row.id, { from: -10, to: -8, status: "completed" });
      await bookingOf(trx, row.id, {
        from: -30,
        to: -28,
        status: "cancelled",
        cancelSource: "learner",
      });
      const found = await getLearnerDetail(trx, row.id);
      if (!found.ok) throw new Error("expected the learner");
      expect(found.value.learner).toEqual({
        id: row.id,
        name: "Pat Lee",
        company: "Acme",
        email: row.email,
        timezone: "UTC",
        status: "active",
        reservationCount: 1,
        emailEditable: true,
        setPasswordPending: true,
      });
    }));

  it("returns no bookings for a learner who has none", () =>
    inRollback(async (trx) => {
      const { row } = await linked(trx, 9401);
      const found = await getLearnerDetail(trx, row.id);
      expect(found.ok && found.value.bookings).toEqual([]);
    }));

  it("is not found for an admin, a learner with no pk, or an unknown id", () =>
    inRollback(async (trx) => {
      const admin = await makeUser(trx, {
        role: "admin",
        authentik_user_pk: 9404,
      });
      const pending = await makeUser(trx);
      for (const id of [admin.id, pending.id, crypto.randomUUID()])
        expect(await getLearnerDetail(trx, id)).toEqual({
          ok: false,
          error: "not_found",
        });
    }));

  it("writes nothing: an ended confirmed booking stays confirmed", () =>
    inRollback(async (trx) => {
      const { row } = await linked(trx, 9401);
      const ended = await bookingOf(trx, row.id, {
        from: -10,
        to: -8,
        status: "confirmed",
      });
      await getLearnerDetail(trx, row.id);
      const after = await trx
        .selectFrom("bookings")
        .select(["status", "version"])
        .where("id", "=", ended.id)
        .executeTakeFirstOrThrow();
      expect(after).toEqual({ status: "confirmed", version: ended.version });
    }));
});

// covers: AC-1, AC-2 (who the console may show)
describe.skipIf(!hasDb)("isConsoleLearner (spec 0008)", () => {
  it("is true only for a learner with a pk", () =>
    inRollback(async (trx) => {
      const { row } = await linked(trx, 9401);
      const admin = await makeUser(trx, {
        role: "admin",
        authentik_user_pk: 9404,
      });
      const pending = await makeUser(trx);
      expect(await isConsoleLearner(trx, row.id)).toBe(true);
      for (const id of [admin.id, pending.id, crypto.randomUUID()])
        expect(await isConsoleLearner(trx, id)).toBe(false);
    }));
});

const welcomePayloads = async (trx: Kysely<DB>, id: string) =>
  (
    await trx
      .selectFrom("jobs")
      .select("payload")
      .where("kind", "=", "send_welcome")
      .where("idempotency_key", "like", `welcome:${id}%`)
      .execute()
  ).map((j) => j.payload);

// covers: spec 0014 AC-15. One worker serves dev and prod, so every welcome
// job carries the origin of the app that queued it.
describe.skipIf(!hasDb)(
  "welcome jobs carry the app's origin (spec 0014 AC-15)",
  () => {
    it("on an add", () =>
      inRollback(async (trx) => {
        const admin = await makeUser(trx, { role: "admin" });
        const values = input();
        await createLearner(
          fakeAuthentik([]).api,
          asConn(trx),
          values,
          admin.id,
        );
        const row = await rowOf(trx, values.email);
        expect(await welcomePayloads(trx, row?.id ?? "")).toEqual([
          { userId: row?.id, appUrl: appUrl() },
        ]);
      }));

    it("on an email fix", () =>
      inRollback(async (trx) => {
        const admin = await makeUser(trx, { role: "admin" });
        const { row, account } = await linked(trx, 11);
        await updateLearner(
          fakeAuthentik([account]).api,
          asConn(trx),
          row.id,
          asInput(row, { email: `fixed-${unique()}@x.test` }),
          admin.id,
        );
        expect(await welcomePayloads(trx, row.id)).toEqual([
          { userId: row.id, appUrl: appUrl() },
        ]);
      }));

    it("on an admin resend", () =>
      inRollback(async (trx) => {
        const admin = await makeUser(trx, { role: "admin" });
        const { row } = await linked(trx, 11);
        await resendSetPasswordByAdmin(asConn(trx), row.id, admin.id);
        expect(await welcomePayloads(trx, row.id)).toEqual([
          { userId: row.id, appUrl: appUrl() },
        ]);
      }));
  },
);

// covers: spec 0019 AC-7
describe.skipIf(!hasDb)("nileLoginsForUser", () => {
  it("lists the logins newest use first and marks the latest", () =>
    inRollback(async (trx) => {
      const user = await makeUser(trx);
      await trx
        .insertInto("learner_domain_logins")
        .values([
          {
            user_id: user.id,
            domain: "a.example.test",
            username: "ana@a.example.test",
            used_at: sql<Date>`now() - interval '2 days'`,
          },
          {
            user_id: user.id,
            domain: "b.example.test",
            username: "ana@b.example.test",
            used_at: sql<Date>`now() - interval '1 day'`,
          },
        ])
        .execute();
      expect(await nileLoginsForUser(trx, user.id)).toEqual([
        {
          domain: "b.example.test",
          username: "ana@b.example.test",
          lastSetByBooking: true,
        },
        {
          domain: "a.example.test",
          username: "ana@a.example.test",
          lastSetByBooking: false,
        },
      ]);
    }));
});
