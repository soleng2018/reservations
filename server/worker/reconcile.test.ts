import { sql, type Kysely, type Transaction } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fakeAuthentik,
  fakeLearner,
  fakeUser,
  fakeGroup,
  groupWrites,
  markedGroup,
} from "@/server/authentik/testing";
import {
  cancelOwnBooking,
  rescheduleOwnBooking,
} from "@/server/booking/manage";
import {
  asConn,
  hasDb,
  inRollback,
  makeAuthUser,
  makeTestbed,
  makeType,
  makeUser,
  slot,
} from "@/server/db/testing";
import type {
  RevokeSource,
  VmRevoke,
  VmRevoker,
} from "@/server/cloudflare/access";
import type { DB } from "@/server/db/types";
import { reconcileAccess } from "./reconcile";

// No CLOUDFLARE key: the revoke is off (spec 0012 AC-11).
const OFF = async (): Promise<RevokeSource> => ({ kind: "off" });

const groupPk = () => crypto.randomUUID();

async function bookingOn(
  trx: Kysely<DB>,
  testbedId: string,
  typeId: string,
  authentikPk: number,
  from: number,
  to: number,
) {
  const user = await makeUser(trx, { authentik_user_pk: authentikPk });
  const booking = await trx
    .insertInto("bookings")
    .values({
      user_id: user.id,
      testbed_id: testbedId,
      testbed_type_id: typeId,
      starts_at: slot(from),
      ends_at: slot(to),
      status: "confirmed",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return { user, booking };
}

const audited = (trx: Kysely<DB>, action: string) =>
  trx
    .selectFrom("audit_events")
    .select(["target_type", "target_id", "metadata"])
    .where("action", "=", action)
    // Only this test's rows: they carry the rollback transaction's now(),
    // while rows committed earlier (an e2e run) are older.
    .where("created_at", ">=", sql<Date>`now()`)
    .execute();

// pk numbers high enough never to meet a real Authentik pk in the shared DB.
const PK = 900_000 + Math.floor(Math.random() * 90_000);

// covers: AC-12, spec 0017 AC-4 (no group is ever written)
describe.skipIf(!hasDb)("reconcileAccess (AC-12)", () => {
  it("adds the Current learner, removes the ended one, keeps untagged members", () =>
    inRollback(async (trx) => {
      const type = await makeType(trx);
      const pk = groupPk();
      const testbed = await makeTestbed(trx, type.id, {
        authentik_group_pk: pk,
      });
      const now = await bookingOn(trx, testbed.id, type.id, PK + 1, -1, 2);
      const ended = await makeUser(trx, { authentik_user_pk: PK + 2 });
      const ak = fakeAuthentik(
        [
          fakeLearner(PK + 1),
          fakeLearner(PK + 2, { groups: [pk] }),
          fakeUser({ pk: PK + 3, groups: [pk] }),
        ],
        {
          groups: [markedGroup(pk, testbed.name)],
          sessions: [
            {
              uuid: "s1",
              user: PK + 2,
              username: `learner-${PK + 2}@x.test`,
            },
          ],
        },
      );
      await reconcileAccess(ak.api, asConn(trx), OFF);

      const members = ak.users.filter((u) => u.groups.includes(pk));
      expect(members.map((u) => u.pk).sort()).toEqual([PK + 1, PK + 3]);
      expect(ak.sessions).toEqual([]);
      expect(groupWrites(ak.writes)).toEqual([]);
      expect(ak.groupReads.every((g) => g.includeUsers === "false")).toBe(true);
      expect(await audited(trx, "access.granted")).toEqual([
        expect.objectContaining({
          target_type: "booking",
          target_id: now.booking.id,
        }),
      ]);
      expect(await audited(trx, "access.revoked")).toEqual([
        expect.objectContaining({ target_type: "user", target_id: ended.id }),
      ]);
    }));

  it("empties a soft deleted testbed's group of tagged learners", () =>
    inRollback(async (trx) => {
      const type = await makeType(trx);
      const pk = groupPk();
      const testbed = await makeTestbed(trx, type.id, {
        authentik_group_pk: pk,
      });
      await bookingOn(trx, testbed.id, type.id, PK + 1, -1, 2);
      await trx
        .updateTable("testbeds")
        .set({ deleted_at: new Date() })
        .where("id", "=", testbed.id)
        .execute();
      const ak = fakeAuthentik([fakeLearner(PK + 1, { groups: [pk] })], {
        groups: [markedGroup(pk, testbed.name)],
      });
      await reconcileAccess(ak.api, asConn(trx), OFF);
      expect(ak.users[0]?.groups).toEqual([]);
    }));

  it("skips a missing or failing group and still runs the next", () =>
    inRollback(async (trx) => {
      const type = await makeType(trx);
      const [gone, broken, good] = [groupPk(), groupPk(), groupPk()];
      const tb = (pk: string) =>
        makeTestbed(trx, type.id, { authentik_group_pk: pk });
      const [a, b, c] = [await tb(gone), await tb(broken), await tb(good)];
      await bookingOn(trx, a.id, type.id, PK + 1, -1, 2);
      await bookingOn(trx, b.id, type.id, PK + 2, -1, 2);
      await bookingOn(trx, c.id, type.id, PK + 3, -1, 2);
      const ak = fakeAuthentik(
        [fakeLearner(PK + 1), fakeLearner(PK + 2), fakeLearner(PK + 3)],
        {
          groups: [markedGroup(broken, b.name), markedGroup(good, c.name)],
          fail: (m, p) => p.startsWith(`/core/groups/${broken}/`),
        },
      );
      await reconcileAccess(ak.api, asConn(trx), OFF);
      expect(ak.users.find((u) => u.pk === PK + 3)?.groups).toEqual([good]);
      expect(ak.users.find((u) => u.pk === PK + 2)?.groups).toEqual([]);
    }));

  it("writes no audit row when the add fails", () =>
    inRollback(async (trx) => {
      const type = await makeType(trx);
      const pk = groupPk();
      const testbed = await makeTestbed(trx, type.id, {
        authentik_group_pk: pk,
      });
      const { booking } = await bookingOn(
        trx,
        testbed.id,
        type.id,
        PK + 1,
        -1,
        2,
      );
      const ak = fakeAuthentik([fakeLearner(PK + 1)], {
        groups: [markedGroup(pk, testbed.name)],
        fail: (m, p) => p.endsWith("/add_user/"),
      });
      await reconcileAccess(ak.api, asConn(trx), OFF);
      const rows = await audited(trx, "access.granted");
      expect(rows.filter((r) => r.target_id === booking.id)).toEqual([]);
    }));

  it("reads members over 100 across pages", () =>
    inRollback(async (trx) => {
      const type = await makeType(trx);
      const pk = groupPk();
      const testbed = await makeTestbed(trx, type.id, {
        authentik_group_pk: pk,
      });
      const stale = Array.from({ length: 130 }, (_, i) =>
        fakeLearner(PK + 10 + i, { groups: [pk] }),
      );
      const ak = fakeAuthentik(stale, {
        groups: [markedGroup(pk, testbed.name)],
      });
      await reconcileAccess(ak.api, asConn(trx), OFF);
      expect(ak.users.filter((u) => u.groups.includes(pk))).toEqual([]);
    }));
});

// covers: spec 0008 AC-11
describe.skipIf(!hasDb)("reconcileAccess skips deactivated learners", () => {
  it("removes a deactivated learner even with a confirmed Current booking", () =>
    inRollback(async (trx) => {
      const type = await makeType(trx);
      const pk = groupPk();
      const testbed = await makeTestbed(trx, type.id, {
        authentik_group_pk: pk,
      });
      const { user } = await bookingOn(trx, testbed.id, type.id, PK + 7, -1, 2);
      // Forced: a confirmed booking that slipped past the deactivation.
      await trx
        .updateTable("users")
        .set({ status: "deactivated", deactivated_at: sql<Date>`now()` })
        .where("id", "=", user.id)
        .execute();
      const ak = fakeAuthentik([fakeLearner(PK + 7, { groups: [pk] })], {
        groups: [markedGroup(pk, testbed.name)],
      });

      await reconcileAccess(ak.api, asConn(trx), OFF);
      expect(ak.writes).toContain(`POST /core/groups/${pk}/remove_user/`);
      expect(ak.users[0]?.groups).toEqual([]);
    }));
});

// covers: spec 0011 AC-16
describe.skipIf(!hasDb)(
  "reconcileAccess after a learner's change (spec 0011)",
  () => {
    // A learner in a Current booking on `a`, already in its group, with one
    // Authentik session and one app (Better Auth) session.
    async function inLab(trx: Transaction<DB>) {
      const type = await makeType(trx);
      const [pkA, pkB] = [groupPk(), groupPk()];
      const u = crypto.randomUUID().slice(0, 8);
      const a = await makeTestbed(trx, type.id, {
        name: `a ${u}`,
        authentik_group_pk: pkA,
      });
      const b = await makeTestbed(trx, type.id, {
        name: `b ${u}`,
        authentik_group_pk: pkB,
      });
      const authUserId = await makeAuthUser(trx, PK + 20, 1);
      const { user, booking } = await bookingOn(
        trx,
        a.id,
        type.id,
        PK + 20,
        -1,
        2,
      );
      await trx
        .updateTable("users")
        .set({ auth_user_id: authUserId })
        .where("id", "=", user.id)
        .execute();
      const version = (
        await trx
          .selectFrom("bookings")
          .select("version")
          .where("id", "=", booking.id)
          .executeTakeFirstOrThrow()
      ).version;
      const ak = fakeAuthentik([fakeLearner(PK + 20, { groups: [pkA] })], {
        groups: [markedGroup(pkA, a.name), markedGroup(pkB, b.name)],
        sessions: [
          { uuid: "s20", user: PK + 20, username: `learner-${PK + 20}@x.test` },
        ],
      });
      const appSessions = async () =>
        (
          await trx
            .selectFrom("hol_auth.session")
            .select("id")
            .where("userId", "=", authUserId)
            .execute()
        ).length;
      return { a, b, pkA, pkB, user, booking, version, ak, appSessions };
    }

    it("removes a learner who cancelled their Current booking and ends their Authentik sessions", () =>
      inRollback(async (trx) => {
        const w = await inLab(trx);
        expect(
          await cancelOwnBooking(
            asConn(trx),
            w.user.id,
            w.booking.id,
            w.version,
          ),
        ).toEqual({ ok: true, value: undefined });
        await reconcileAccess(w.ak.api, asConn(trx), OFF);
        expect(w.ak.users[0]?.groups).toEqual([]);
        expect(w.ak.sessions).toEqual([]);
        expect(await audited(trx, "access.revoked")).toEqual([
          expect.objectContaining({
            target_type: "user",
            target_id: w.user.id,
          }),
        ]);
        // The app session stays, so they stay on /reservations.
        expect(await w.appSessions()).toBe(1);
      }));

    it("removes a learner who moved their Current booking later", () =>
      inRollback(async (trx) => {
        const w = await inLab(trx);
        const moved = await rescheduleOwnBooking(asConn(trx), w.user.id, {
          bookingId: w.booking.id,
          version: w.version,
          startsAt: slot(24),
        });
        expect(moved.ok).toBe(true);
        await reconcileAccess(w.ak.api, asConn(trx), OFF);
        expect(w.ak.users[0]?.groups).toEqual([]);
        expect(w.ak.sessions).toEqual([]);
        expect(await w.appSessions()).toBe(1);
      }));

    it("adds the learner to the new testbed's group once a move there starts", () =>
      inRollback(async (trx) => {
        const w = await inLab(trx);
        // Someone else holds a at the new time, so the move lands on b.
        await bookingOn(trx, w.a.id, w.a.testbed_type_id, PK + 21, 23, 27);
        const moved = await rescheduleOwnBooking(asConn(trx), w.user.id, {
          bookingId: w.booking.id,
          version: w.version,
          startsAt: slot(24),
        });
        expect(moved.ok && moved.value.testbedName).toBe(w.b.name);
        // Forced: the moved booking's start arrives.
        await trx
          .updateTable("bookings")
          .set({ starts_at: slot(-1), ends_at: slot(1) })
          .where("id", "=", w.booking.id)
          .execute();
        await reconcileAccess(w.ak.api, asConn(trx), OFF);
        expect(w.ak.users.find((u) => u.pk === PK + 20)?.groups).toEqual([
          w.pkB,
        ]);
      }));
  },
);

// covers: spec 0012 AC-10, AC-11, AC-12
describe.skipIf(!hasDb)(
  "reconcileAccess and the Cloudflare revoke (spec 0012)",
  () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    // A source that counts its reads, and a fake revoker that records each
    // call and runs `onCall` first, to see what had happened by then.
    const source = (s: RevokeSource) => {
      let reads = 0;
      return {
        get reads() {
          return reads;
        },
        read: async () => {
          reads += 1;
          return s;
        },
      };
    };
    const ON = source({
      kind: "on",
      config: { baseUrl: "https://cloudflare.invalid", apiToken: "t" },
    });
    const fakeRevoker = (
      answer: VmRevoke = "done",
      onCall: () => Promise<void> = async () => undefined,
    ) => {
      const calls: (string | null)[] = [];
      let built = 0;
      return {
        calls,
        get built() {
          return built;
        },
        newRevoker: (): VmRevoker => {
          built += 1;
          return async (email) => {
            calls.push(email);
            await onCall();
            return answer;
          };
        },
      };
    };

    // One testbed whose group holds the given learners, none of them booked.
    async function ended(trx: Kysely<DB>, pks: readonly number[]) {
      const type = await makeType(trx);
      const pk = groupPk();
      const testbed = await makeTestbed(trx, type.id, {
        authentik_group_pk: pk,
      });
      const users = await Promise.all(
        pks.map((p) => makeUser(trx, { authentik_user_pk: p })),
      );
      const ak = (fail?: (m: string, p: string) => boolean) =>
        fakeAuthentik(
          pks.map((p) => fakeLearner(p, { groups: [pk] })),
          {
            groups: [markedGroup(pk, testbed.name)],
            sessions: pks.map((p) => ({
              uuid: `s${p}`,
              user: p,
              username: `learner-${p}@x.test`,
            })),
            fail,
          },
        );
      return { users, ak };
    }

    const revoked = async (trx: Kysely<DB>) =>
      (await audited(trx, "access.revoked")).map((r) => r.metadata);

    it("ends sessions, then revokes the learner's email, then writes the audit row", () =>
      inRollback(async (trx) => {
        const { users, ak } = await ended(trx, [PK + 40]);
        const fake = ak();
        const seen: { sessions: number; audits: number }[] = [];
        const revoker = fakeRevoker("done", async () => {
          seen.push({
            sessions: fake.sessions.length,
            audits: (await audited(trx, "access.revoked")).length,
          });
        });
        await reconcileAccess(
          fake.api,
          asConn(trx),
          ON.read,
          revoker.newRevoker,
        );

        expect(revoker.calls).toEqual([users[0]?.email]);
        expect(seen).toEqual([{ sessions: 0, audits: 0 }]);
        expect(await revoked(trx)).toEqual([
          expect.objectContaining({ sessionsEnded: true, vmRevoke: "done" }),
        ]);
      }));

    // users.email keeps its case (unique on lower(email)), and Cloudflare's
    // email claim is the stored value, so the revoke must not normalize it.
    it("revokes the email exactly as stored, case and all", () =>
      inRollback(async (trx) => {
        const { users, ak } = await ended(trx, [PK + 44]);
        const stored = `Mixed.Case-${users[0]?.id}@Example.Test`;
        await trx
          .updateTable("users")
          .set({ email: stored })
          .where("id", "=", users[0]?.id ?? "")
          .execute();
        const revoker = fakeRevoker();
        await reconcileAccess(
          ak().api,
          asConn(trx),
          ON.read,
          revoker.newRevoker,
        );
        expect(revoker.calls).toEqual([stored]);
      }));

    it("still revokes when ending the sessions failed", () =>
      inRollback(async (trx) => {
        const { users, ak } = await ended(trx, [PK + 41]);
        const fake = ak((m, p) =>
          p.startsWith("/core/authenticated_sessions/"),
        );
        const revoker = fakeRevoker();
        vi.spyOn(console, "error").mockImplementation(() => {});
        await reconcileAccess(
          fake.api,
          asConn(trx),
          ON.read,
          revoker.newRevoker,
        );
        expect(revoker.calls).toEqual([users[0]?.email]);
        expect(await revoked(trx)).toEqual([
          expect.objectContaining({ sessionsEnded: false, vmRevoke: "done" }),
        ]);
      }));

    it("records a failed revoke and logs the user id, never the email", () =>
      inRollback(async (trx) => {
        const { users, ak } = await ended(trx, [PK + 42]);
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        await reconcileAccess(
          ak().api,
          asConn(trx),
          ON.read,
          fakeRevoker("failed").newRevoker,
        );
        expect(await revoked(trx)).toEqual([
          expect.objectContaining({ vmRevoke: "failed" }),
        ]);
        const logged = JSON.stringify(error.mock.calls);
        expect(logged).toContain(users[0]?.id);
        expect(logged).not.toContain(users[0]?.email);
      }));

    it("fails a learner with no users row with no revoker call", () =>
      inRollback(async (trx) => {
        const type = await makeType(trx);
        const pk = groupPk();
        const testbed = await makeTestbed(trx, type.id, {
          authentik_group_pk: pk,
        });
        const fake = fakeAuthentik([fakeLearner(PK + 43, { groups: [pk] })], {
          groups: [markedGroup(pk, testbed.name)],
        });
        const revoker = fakeRevoker();
        vi.spyOn(console, "error").mockImplementation(() => {});
        await reconcileAccess(
          fake.api,
          asConn(trx),
          ON.read,
          revoker.newRevoker,
        );
        expect(revoker.calls).toEqual([]);
        expect(await audited(trx, "access.revoked")).toEqual([
          expect.objectContaining({
            target_type: "authentik_group",
            metadata: expect.objectContaining({ vmRevoke: "failed" }),
          }),
        ]);
      }));

    it("records off with no revoker when there is no key", () =>
      inRollback(async (trx) => {
        const { ak } = await ended(trx, [PK + 44]);
        const revoker = fakeRevoker();
        await reconcileAccess(ak().api, asConn(trx), OFF, revoker.newRevoker);
        expect(revoker.built).toBe(0);
        expect(await revoked(trx)).toEqual([
          expect.objectContaining({ sessionsEnded: true, vmRevoke: "off" }),
        ]);
      }));

    it("records failed with no call for a key it can't read, saying so once per run", () =>
      inRollback(async (trx) => {
        const { ak } = await ended(trx, [PK + 45, PK + 46]);
        const revoker = fakeRevoker();
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        await reconcileAccess(
          ak().api,
          asConn(trx),
          source({ kind: "broken" }).read,
          revoker.newRevoker,
        );
        expect(revoker.built).toBe(0);
        expect(await revoked(trx)).toEqual([
          expect.objectContaining({ vmRevoke: "failed" }),
          expect.objectContaining({ vmRevoke: "failed" }),
        ]);
        const unreadable = error.mock.calls.filter((c) =>
          String(c[0]).includes("can't be read"),
        );
        expect(unreadable).toHaveLength(1);
      }));

    it("logs nothing for a broken key in a run with no removal", () =>
      inRollback(async (trx) => {
        const { ak } = await ended(trx, []);
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        await reconcileAccess(
          ak().api,
          asConn(trx),
          source({ kind: "broken" }).read,
        );
        // Other testbeds in the shared database log their own lines.
        expect(JSON.stringify(error.mock.calls)).not.toContain("can't be read");
      }));

    it("makes no revoke and writes no audit row when the removal fails", () =>
      inRollback(async (trx) => {
        const { ak } = await ended(trx, [PK + 47]);
        const fake = ak((m, p) => p.endsWith("/remove_user/"));
        const revoker = fakeRevoker();
        vi.spyOn(console, "error").mockImplementation(() => {});
        await reconcileAccess(
          fake.api,
          asConn(trx),
          ON.read,
          revoker.newRevoker,
        );
        expect(revoker.calls).toEqual([]);
        expect(fake.sessions).toHaveLength(1);
        expect(await revoked(trx)).toEqual([]);
      }));

    it("reads the source and builds the revoker once per run, across groups", () =>
      inRollback(async (trx) => {
        const first = await ended(trx, [PK + 48]);
        const second = await ended(trx, [PK + 49]);
        // One fake Authentik holding both groups.
        const both = fakeAuthentik(
          [
            ...first.ak().users.map((u) => ({ ...u })),
            ...second.ak().users.map((u) => ({ ...u })),
          ],
          {
            groups: [
              ...(await trx
                .selectFrom("testbeds")
                .select(["authentik_group_pk", "name"])
                .where("authentik_group_pk", "in", [
                  ...first.ak().users.flatMap((u) => u.groups),
                  ...second.ak().users.flatMap((u) => u.groups),
                ])
                .execute()
                .then((rows) =>
                  rows.map((r) =>
                    markedGroup(r.authentik_group_pk ?? "", r.name),
                  ),
                )),
            ],
          },
        );
        const counted = source({
          kind: "on",
          config: { baseUrl: "https://cloudflare.invalid", apiToken: "t" },
        });
        const revoker = fakeRevoker();
        await reconcileAccess(
          both.api,
          asConn(trx),
          counted.read,
          revoker.newRevoker,
        );
        expect(counted.reads).toBe(1);
        expect(revoker.built).toBe(1);
        expect(revoker.calls).toHaveLength(2);
      }));
  },
);

const errorsAbout = (spy: { mock: { calls: unknown[][] } }, id: string) =>
  spy.mock.calls.map((c) => String(c[0])).filter((line) => line.includes(id));

// covers: spec 0017 AC-10 (the guard on every write, the stale check)
describe.skipIf(!hasDb)("reconcileAccess groups (spec 0017 AC-10)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses an add to a group without the marker, yet still removes ended learners from it", () =>
    inRollback(async (trx) => {
      const type = await makeType(trx);
      const pk = groupPk();
      const testbed = await makeTestbed(trx, type.id, {
        authentik_group_pk: pk,
      });
      await bookingOn(trx, testbed.id, type.id, PK + 60, -1, 2);
      const ak = fakeAuthentik(
        [
          fakeLearner(PK + 60),
          // Tagged, in the group, no booking: goes on the first tick.
          fakeLearner(PK + 62, { groups: [pk] }),
          // Untagged: never touched.
          fakeUser({ pk: PK + 63, groups: [pk] }),
        ],
        { groups: [fakeGroup(pk, testbed.name)] },
      );
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});
      await reconcileAccess(ak.api, asConn(trx), OFF);

      const members = ak.users.filter((u) => u.groups.includes(pk));
      expect(members.map((u) => u.pk)).toEqual([PK + 63]);
      expect(await audited(trx, "access.granted")).toEqual([]);
      // One line for the testbed, with the count of refused adds.
      const lines = errorsAbout(error, testbed.id);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("1 add(s) refused");
      expect(lines[0]).toContain("not_testbed_group");
    }));

  it("never adds to a group with a role, a parent, or a superuser flag", () =>
    inRollback(async (trx) => {
      const type = await makeType(trx);
      const [rolePk, parentPk, superPk] = [groupPk(), groupPk(), groupPk()];
      const tb = (pk: string) =>
        makeTestbed(trx, type.id, { authentik_group_pk: pk });
      const [a, b, c] = [
        await tb(rolePk),
        await tb(parentPk),
        await tb(superPk),
      ];
      await bookingOn(trx, a.id, type.id, PK + 64, -1, 2);
      await bookingOn(trx, b.id, type.id, PK + 65, -1, 2);
      await bookingOn(trx, c.id, type.id, PK + 66, -1, 2);
      const ak = fakeAuthentik(
        [fakeLearner(PK + 64), fakeLearner(PK + 65), fakeLearner(PK + 66)],
        {
          groups: [
            markedGroup(rolePk, a.name, { roles: ["r1"] }),
            markedGroup(parentPk, b.name, { parents: ["admins-uuid"] }),
            markedGroup(superPk, c.name, { is_superuser: true }),
          ],
        },
      );
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});
      await reconcileAccess(ak.api, asConn(trx), OFF);
      expect(ak.users.flatMap((u) => u.groups)).toEqual([]);
      expect(ak.writes).toEqual([]);
    }));

  it("finds a recreated group by name, stores its pk, audits it, and adds the learner in the same run", () =>
    inRollback(async (trx) => {
      const type = await makeType(trx);
      const [oldPk, newPk] = [groupPk(), groupPk()];
      const testbed = await makeTestbed(trx, type.id, {
        authentik_group_pk: oldPk,
      });
      const { booking, user } = await bookingOn(
        trx,
        testbed.id,
        type.id,
        PK + 70,
        -1,
        2,
      );
      // The owner deleted the old group and made it again: a new pk.
      const ak = fakeAuthentik([fakeLearner(PK + 70)], {
        groups: [markedGroup(newPk, testbed.name)],
      });
      await reconcileAccess(ak.api, asConn(trx), OFF);

      const stored = await trx
        .selectFrom("testbeds")
        .select("authentik_group_pk")
        .where("id", "=", testbed.id)
        .executeTakeFirstOrThrow();
      expect(stored.authentik_group_pk).toBe(newPk);
      expect(await audited(trx, "testbed.group_relinked")).toEqual([
        expect.objectContaining({
          target_type: "testbed",
          target_id: testbed.id,
          metadata: { testbedId: testbed.id, from: oldPk, to: newPk },
        }),
      ]);
      expect(ak.users[0]?.groups).toEqual([newPk]);
      expect(await audited(trx, "access.granted")).toEqual([
        expect.objectContaining({ target_id: booking.id }),
      ]);
      expect(user.id).toBeDefined();
      expect(groupWrites(ak.writes)).toEqual([]);
    }));

  it("treats a group the owner renamed as stale: relinks by name, and writes nothing to the renamed group", () =>
    inRollback(async (trx) => {
      const type = await makeType(trx);
      const [renamedPk, namedPk] = [groupPk(), groupPk()];
      const testbed = await makeTestbed(trx, type.id, {
        authentik_group_pk: renamedPk,
      });
      await bookingOn(trx, testbed.id, type.id, PK + 71, -1, 2);
      const ak = fakeAuthentik(
        [
          fakeLearner(PK + 71),
          // A tagged member of the renamed group, who must stay.
          fakeLearner(PK + 72, { groups: [renamedPk] }),
        ],
        {
          groups: [
            markedGroup(renamedPk, "RenamedByTheOwner"),
            markedGroup(namedPk, testbed.name),
          ],
        },
      );
      await reconcileAccess(ak.api, asConn(trx), OFF);
      expect(ak.users.find((u) => u.pk === PK + 71)?.groups).toEqual([namedPk]);
      expect(ak.users.find((u) => u.pk === PK + 72)?.groups).toEqual([
        renamedPk,
      ]);
      expect(ak.writes).toEqual([`POST /core/groups/${namedPk}/add_user/`]);
    }));

  it("skips a stale testbed whose name matches no usable group, logging once and writing nothing", () =>
    inRollback(async (trx) => {
      const type = await makeType(trx);
      const [stalePk, goodPk] = [groupPk(), groupPk()];
      const stale = await makeTestbed(trx, type.id, {
        authentik_group_pk: stalePk,
      });
      const good = await makeTestbed(trx, type.id, {
        authentik_group_pk: goodPk,
      });
      await bookingOn(trx, stale.id, type.id, PK + 73, -1, 2);
      await bookingOn(trx, good.id, type.id, PK + 74, -1, 2);
      const ak = fakeAuthentik(
        [
          fakeLearner(PK + 73),
          fakeLearner(PK + 74),
          fakeLearner(PK + 75, { groups: [stalePk] }),
        ],
        {
          groups: [
            markedGroup(stalePk, "RenamedByTheOwner"),
            markedGroup(goodPk, good.name),
          ],
        },
      );
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      await reconcileAccess(ak.api, asConn(trx), OFF);

      expect(errorsAbout(error, stale.id)).toHaveLength(1);
      expect(ak.users.find((u) => u.pk === PK + 73)?.groups).toEqual([]);
      // The stale group is untouched, its tagged member included.
      expect(ak.users.find((u) => u.pk === PK + 75)?.groups).toEqual([stalePk]);
      // The other testbed still reconciled.
      expect(ak.users.find((u) => u.pk === PK + 74)?.groups).toEqual([goodPk]);
      expect(await audited(trx, "testbed.group_relinked")).toEqual([]);
    }));

  it("does not relink to a group another live testbed holds", () =>
    inRollback(async (trx) => {
      const type = await makeType(trx);
      const [stalePk, takenPk] = [groupPk(), groupPk()];
      const stale = await makeTestbed(trx, type.id, {
        authentik_group_pk: stalePk,
      });
      // `stale`'s name is a group another live testbed already holds.
      const owner = await makeTestbed(trx, type.id, {
        name: "Other",
        authentik_group_pk: takenPk,
      });
      await bookingOn(trx, stale.id, type.id, PK + 76, -1, 2);
      const ak = fakeAuthentik([fakeLearner(PK + 76)], {
        groups: [markedGroup(takenPk, stale.name)],
      });
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      await reconcileAccess(ak.api, asConn(trx), OFF);

      const row = await trx
        .selectFrom("testbeds")
        .select("authentik_group_pk")
        .where("id", "=", stale.id)
        .executeTakeFirstOrThrow();
      expect(row.authentik_group_pk).toBe(stalePk);
      expect(errorsAbout(error, stale.id)).toHaveLength(1);
      expect(owner.id).toBeDefined();
      expect(ak.writes).toEqual([]);
    }));

  it("leaves a deleted testbed's missing group alone: no relink, no error log", () =>
    inRollback(async (trx) => {
      const type = await makeType(trx);
      const pk = groupPk();
      const gone = await makeTestbed(trx, type.id, {
        authentik_group_pk: pk,
        deleted_at: new Date(),
      });
      // A group with the deleted testbed's name exists, but is not relinked.
      const ak = fakeAuthentik([], {
        groups: [markedGroup(groupPk(), gone.name)],
      });
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      await reconcileAccess(ak.api, asConn(trx), OFF);
      expect(errorsAbout(error, gone.id)).toEqual([]);
      expect(await audited(trx, "testbed.group_relinked")).toEqual([]);
      const row = await trx
        .selectFrom("testbeds")
        .select("authentik_group_pk")
        .where("id", "=", gone.id)
        .executeTakeFirstOrThrow();
      expect(row.authentik_group_pk).toBe(pk);
    }));

  // covers: AC-10 (a), a deleted testbed and a new live one on one group
  it.each([
    ["deleted first", -2, 0],
    ["live first", 0, -2],
  ] as const)(
    "does not let a deleted testbed's row remove the live one's learners (%s)",
    (_, liveAge, deletedAge) =>
      inRollback(async (trx) => {
        const type = await makeType(trx);
        const pk = groupPk();
        const at = (hours: number) => new Date(Date.now() + hours * 3_600_000);
        const live = await makeTestbed(trx, type.id, {
          authentik_group_pk: pk,
          created_at: at(liveAge),
        });
        // The same name and group again after a delete and re-add.
        await makeTestbed(trx, type.id, {
          name: `${live.name} old`,
          authentik_group_pk: pk,
          deleted_at: new Date(),
          created_at: at(deletedAge),
        });
        await bookingOn(trx, live.id, type.id, PK + 80, -1, 2);
        const ak = fakeAuthentik(
          [
            fakeLearner(PK + 80, { groups: [pk] }),
            // Tagged and with no booking: this one does go.
            fakeLearner(PK + 81, { groups: [pk] }),
          ],
          { groups: [markedGroup(pk, live.name)] },
        );
        await reconcileAccess(ak.api, asConn(trx), OFF);
        expect(ak.users.find((u) => u.pk === PK + 80)?.groups).toEqual([pk]);
        expect(ak.users.find((u) => u.pk === PK + 81)?.groups).toEqual([]);
        expect(await audited(trx, "access.revoked")).toHaveLength(1);
      }),
  );

  it("skips a released testbed: its group is not even read", () =>
    inRollback(async (trx) => {
      const type = await makeType(trx);
      const pk = groupPk();
      await makeTestbed(trx, type.id, {
        authentik_group_pk: pk,
        deleted_at: new Date(),
        authentik_group_deleted_at: new Date(),
      });
      const ak = fakeAuthentik([fakeLearner(PK + 82, { groups: [pk] })], {
        groups: [markedGroup(pk, "Released")],
      });
      await reconcileAccess(ak.api, asConn(trx), OFF);
      expect(ak.groupReads.filter((g) => g.path.includes(pk))).toEqual([]);
      expect(ak.writes).toEqual([]);
    }));

  // covers: AC-10 (d), a not found answer on the read just before a write
  it("skips the write when the group is gone at the fresh read, logging once", () =>
    inRollback(async (trx) => {
      const type = await makeType(trx);
      const pk = groupPk();
      const testbed = await makeTestbed(trx, type.id, {
        authentik_group_pk: pk,
      });
      await bookingOn(trx, testbed.id, type.id, PK + 83, -1, 2);
      // The first read (the reconciler's own) answers; later ones are 404.
      let reads = 0;
      const ak = fakeAuthentik([fakeLearner(PK + 83)], {
        groups: [markedGroup(pk, testbed.name)],
        reply: (m, p) =>
          m === "GET" && p === `/core/groups/${pk}/` && ++reads > 1
            ? new Response('{"detail":"Not found."}', {
                status: 404,
                headers: { "Content-Type": "application/json" },
              })
            : undefined,
      });
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      await reconcileAccess(ak.api, asConn(trx), OFF);
      expect(ak.writes).toEqual([]);
      const lines = errorsAbout(error, testbed.id);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("1 add(s) refused");
    }));
});
