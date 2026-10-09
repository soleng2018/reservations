import { sql, type Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import {
  fakeAuthentik,
  fakeGroup,
  fakeLearner,
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
  completeEnded,
  purgeRateLimits,
  sweepGuestSagas,
  sweepTestbedCreates,
} from "./sweep";

const ago = (minutes: number) =>
  sql<Date>`now() - make_interval(mins => ${minutes})`;

const exists = async (
  trx: Kysely<DB>,
  table: "testbeds" | "users" | "bookings",
  id: string,
) =>
  (await trx.selectFrom(table).select("id").where("id", "=", id).execute())
    .length === 1;

// A testbed that never stored its group pk, created `minutes` ago.
async function unfinished(trx: Kysely<DB>, typeId: string, minutes: number) {
  const row = await makeTestbed(trx, typeId, { authentik_group_pk: null });
  await trx
    .updateTable("testbeds")
    .set({ created_at: ago(minutes) })
    .where("id", "=", row.id)
    .execute();
  return row;
}

// covers: AC-11
describe.skipIf(!hasDb)("worker sweepers (AC-11)", () => {
  it("undoes a testbed create older than 10 minutes, group and row", () =>
    inRollback(async (trx) => {
      const type = await makeType(trx);
      const old = await unfinished(trx, type.id, 11);
      const fresh = await makeTestbed(trx, type.id, {
        authentik_group_pk: null,
      });
      const foreign = await unfinished(trx, type.id, 11);
      const ak = fakeAuthentik([], {
        groups: [
          fakeGroup("g-old", `pod-${old.slug}`, { hol_testbed_id: old.id }),
          fakeGroup("g-foreign", `pod-${foreign.slug}`, {
            hol_testbed_id: crypto.randomUUID(),
          }),
        ],
      });
      await sweepTestbedCreates(ak.api, asConn(trx));
      expect(ak.writes).toEqual(["DELETE /core/groups/g-old/"]);
      expect(await exists(trx, "testbeds", old.id)).toBe(false);
      expect(await exists(trx, "testbeds", foreign.id)).toBe(false);
      expect(ak.groups.some((g) => g.pk === "g-foreign")).toBe(true);
      expect(await exists(trx, "testbeds", fresh.id)).toBe(true);
    }));

  it("compensates a guest saga stuck in provisioning", () =>
    inRollback(async (trx) => {
      const type = await makeType(trx);
      const testbed = await makeTestbed(trx, type.id);
      const user = await makeUser(trx, {
        authentik_user_pk: 4242,
        authentik_pending_saga: true,
      });
      const booking = await trx
        .insertInto("bookings")
        .values({
          user_id: user.id,
          testbed_id: testbed.id,
          testbed_type_id: type.id,
          starts_at: slot(24),
          ends_at: slot(26),
          status: "provisioning",
          created_at: ago(11),
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      const ak = fakeAuthentik([fakeLearner(4242)]);
      await sweepGuestSagas(ak.api, asConn(trx));
      expect(await exists(trx, "bookings", booking.id)).toBe(false);
      expect(await exists(trx, "users", user.id)).toBe(false);
      expect(ak.writes).toContain("DELETE /core/users/4242/");
    }));

  it("completes ended confirmed bookings only", () =>
    inRollback(async (trx) => {
      const type = await makeType(trx);
      const testbed = await makeTestbed(trx, type.id);
      const [ended, current] = await Promise.all([
        makeUser(trx),
        makeUser(trx),
      ]);
      const insert = (userId: string, from: number, to: number) =>
        trx
          .insertInto("bookings")
          .values({
            user_id: userId,
            testbed_id: testbed.id,
            testbed_type_id: type.id,
            starts_at: slot(from),
            ends_at: slot(to),
            status: "confirmed",
          })
          .returning("id")
          .executeTakeFirstOrThrow();
      const a = await insert(ended.id, -4, -2);
      const b = await insert(current.id, -1, 2);
      await completeEnded(trx);
      const statuses = await trx
        .selectFrom("bookings")
        .select(["id", "status"])
        .where("id", "in", [a.id, b.id])
        .execute();
      expect(Object.fromEntries(statuses.map((s) => [s.id, s.status]))).toEqual(
        { [a.id]: "completed", [b.id]: "confirmed" },
      );
    }));

  it("purges rate limit buckets older than 2 hours", () =>
    inRollback(async (trx) => {
      const key = `test:${crypto.randomUUID()}`;
      await trx
        .insertInto("rate_limits")
        .values([
          { bucket_key: key, window_start: ago(180), count: 1 },
          { bucket_key: key, window_start: ago(30), count: 1 },
        ])
        .execute();
      await purgeRateLimits(trx);
      const left = await trx
        .selectFrom("rate_limits")
        .select("count")
        .where("bucket_key", "=", key)
        .execute();
      expect(left).toHaveLength(1);
    }));
});
