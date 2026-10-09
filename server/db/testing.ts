import "server-only";
import { sql, type Insertable, type Kysely, type Transaction } from "kysely";
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

// Code under test that opens its own `conn.transaction()` cannot run on a
// rollback transaction (Kysely refuses nesting). This view runs each such
// block on `trx` inside a savepoint: a block that throws undoes its own
// writes, as a real transaction would, and everything still rolls back with
// the test.
export function asConn(trx: Transaction<DB>): Kysely<DB> {
  return new Proxy(trx, {
    get(target, prop, receiver) {
      if (prop === "transaction")
        return () => ({
          execute: async <T>(fn: (t: Transaction<DB>) => Promise<T>) => {
            await sql`savepoint as_conn`.execute(target);
            try {
              const value = await fn(target);
              await sql`release savepoint as_conn`.execute(target);
              return value;
            } catch (e) {
              await sql`rollback to savepoint as_conn`.execute(target);
              await sql`release savepoint as_conn`.execute(target);
              throw e;
            }
          },
        });
      const value: unknown = Reflect.get(target, prop, receiver);
      // Kysely uses private fields, so methods must run on the real object.
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

// Runs `fn` inside a savepoint and returns what it threw (undefined if
// nothing), so a test can assert a constraint error and keep using `trx`.
export async function attempt(
  trx: Kysely<DB>,
  fn: () => Promise<unknown>,
): Promise<unknown> {
  await sql`savepoint attempt`.execute(trx);
  try {
    await fn();
    await sql`release savepoint attempt`.execute(trx);
    return undefined;
  } catch (e) {
    await sql`rollback to savepoint attempt`.execute(trx);
    return e;
  }
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

// A Better Auth user with an Authentik account and `sessions` live sessions.
export async function makeAuthUser(
  trx: Kysely<DB>,
  authentikPk: number,
  sessions = 0,
) {
  const id = crypto.randomUUID();
  const now = new Date();
  await trx
    .insertInto("hol_auth.user")
    .values({
      id,
      email: `${id}@example.test`,
      name: "Auth",
      emailVerified: false,
    })
    .execute();
  await trx
    .insertInto("hol_auth.account")
    .values({
      id: crypto.randomUUID(),
      accountId: String(authentikPk),
      providerId: "authentik",
      userId: id,
      updatedAt: now,
    })
    .execute();
  for (let i = 0; i < sessions; i++)
    await trx
      .insertInto("hol_auth.session")
      .values({
        id: crypto.randomUUID(),
        token: crypto.randomUUID(),
        userId: id,
        expiresAt: new Date(now.getTime() + 3_600_000),
        updatedAt: now,
      })
      .execute();
  return id;
}

// A half hour aligned instant `hours` from now (negative for the past).
export function slot(hours: number): Date {
  const halfHour = 30 * 60 * 1000;
  return new Date(
    Math.floor((Date.now() + hours * 3_600_000) / halfHour) * halfHour,
  );
}
