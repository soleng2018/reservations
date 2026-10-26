import { sql, type Kysely } from "kysely";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import {
  applyBookingGapMigration,
  attempt,
  hasDb,
  inRollbackDdl,
  makeTestbed,
  makeType,
  makeUser,
  restoreOldOverlapRule,
  slot,
} from "./testing";
import type { DB } from "./types";

const ruleOf = async (trx: Kysely<DB>) => {
  const { rows } = await sql<{ def: string }>`
    select pg_get_constraintdef(oid) as def from pg_constraint
    where conname = 'bookings_no_overlap'`.execute(trx);
  return rows[0]?.def;
};

// A live booking per learner; `on conflict` never needed, each has its own.
async function liveBooking(
  trx: Kysely<DB>,
  testbed: { id: string; testbed_type_id: string },
  from: number,
  to: number,
) {
  await trx
    .insertInto("bookings")
    .values({
      user_id: (await makeUser(trx)).id,
      testbed_id: testbed.id,
      testbed_type_id: testbed.testbed_type_id,
      starts_at: slot(from),
      ends_at: slot(to),
      status: "confirmed",
    })
    .execute();
}

// Spec 0020 AC-7. Each test first puts the old rule back inside its own
// transaction, so it holds whether or not 0016 is applied to the database.
describe.skipIf(!hasDb)("migration 0016, the cleanup gap", () => {
  afterAll(() => db().destroy());

  it("stops with the pair count and keeps the old rule when a live pair sits in a gap (AC-7)", () =>
    inRollbackDdl(async (trx) => {
      await restoreOldOverlapRule(trx);
      const old = await ruleOf(trx);
      const type = await makeType(trx);
      const testbed = await makeTestbed(trx, type.id);
      await liveBooking(trx, testbed, 24, 26);
      await liveBooking(trx, testbed, 26, 28); // back to back, legal before
      await liveBooking(trx, testbed, 40, 42);
      await liveBooking(trx, testbed, 42.5, 44); // exactly a gap, not a pair

      const failure = await attempt(trx, () => applyBookingGapMigration(trx));
      expect(String(failure)).toContain("1 live booking pair(s)");
      expect(await ruleOf(trx)).toBe(old);
    }));

  it("applies when no live pair sits in a gap (AC-7)", () =>
    inRollbackDdl(async (trx) => {
      await restoreOldOverlapRule(trx);
      const old = await ruleOf(trx);
      const type = await makeType(trx);
      const testbed = await makeTestbed(trx, type.id);
      await liveBooking(trx, testbed, 24, 26);
      await liveBooking(trx, testbed, 26.5, 28);

      expect(await attempt(trx, () => applyBookingGapMigration(trx))).toBe(
        undefined,
      );
      const padded = await ruleOf(trx);
      expect(padded).not.toBe(old);
      expect(padded).toContain("interval");
    }));
});
