import "server-only";
import type { Insertable, Kysely, Transaction } from "kysely";
import { db } from "@/server/db";
import { hasDbEnv } from "@/server/env";
import type { DB, TestbedTypes, Testbeds, Users } from "./types";

// Test support only. Dev and production share one database (spec 0001), so
// every DB test runs inside a transaction that is always rolled back.

export const hasDb = hasDbEnv();

class Rollback extends Error {}

export async function inRollback(
  fn: (trx: Transaction<DB>) => Promise<void>,
  conn: Kysely<DB> = db(),
): Promise<void> {
  await conn
    .transaction()
    .execute(async (trx) => {
      await fn(trx);
      throw new Rollback();
    })
    .catch((e: unknown) => {
      if (!(e instanceof Rollback)) throw e;
    });
}

const unique = () => crypto.randomUUID().slice(0, 8);

export async function makeUser(
  trx: Kysely<DB>,
  overrides: Partial<Insertable<Users>> = {},
) {
  return trx
    .insertInto("users")
    .values({
      role: "learner",
      name: "Test Learner",
      company: "Test Co",
      email: `test-${unique()}@example.test`,
      timezone: "UTC",
      ...overrides,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function makeType(
  trx: Kysely<DB>,
  overrides: Partial<Insertable<TestbedTypes>> = {},
) {
  return trx
    .insertInto("testbed_types")
    .values({
      name: `Type ${unique()}`,
      duration_value: 2,
      duration_unit: "hours",
      ...overrides,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function makeTestbed(
  trx: Kysely<DB>,
  testbedTypeId: string,
  overrides: Partial<Insertable<Testbeds>> = {},
) {
  const id = unique();
  return trx
    .insertInto("testbeds")
    .values({
      name: `Testbed ${id}`,
      slug: `testbed-${id}`,
      testbed_type_id: testbedTypeId,
      portal_url: "https://portal.example.test",
      lms_url: "https://lms.example.test",
      authentik_group_pk: crypto.randomUUID(),
      ...overrides,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

// A half hour aligned instant `hours` from now (negative for the past).
export function slot(hours: number): Date {
  const halfHour = 30 * 60 * 1000;
  return new Date(
    Math.floor((Date.now() + hours * 3_600_000) / halfHour) * halfHour,
  );
}
