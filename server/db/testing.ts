import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { sql, type Insertable, type Kysely, type Transaction } from "kysely";
import { db } from "@/server/db";
import { hasDbEnv } from "@/server/env";
import type { DB, TestbedTypes, Testbeds, Users } from "./types";

// Test support only. Dev and production share one database (spec 0001), so
// every DB test runs inside a transaction that is always rolled back.

export const hasDb = hasDbEnv();

class Rollback extends Error {}

// A test that runs ALTER TABLE on `bookings` (the cleanup gap migration)
// holds an ACCESS EXCLUSIVE lock until its rollback, which would starve every
// other DB test file running beside it. So every test takes this advisory lock
// shared, and a DDL test takes it exclusive first (`inRollbackDdl`).
const DDL_LOCK_KEY = 20_260_020;

async function rollbackWith(
  lock: "shared" | "exclusive" | "none",
  fn: (trx: Transaction<DB>) => Promise<void>,
  conn: Kysely<DB>,
): Promise<void> {
  await conn
    .transaction()
    .execute(async (trx) => {
      if (lock === "shared")
        await sql`select pg_advisory_xact_lock_shared(${DDL_LOCK_KEY})`.execute(
          trx,
        );
      if (lock === "exclusive")
        await sql`select pg_advisory_xact_lock(${DDL_LOCK_KEY})`.execute(trx);
      await fn(trx);
      throw new Rollback();
    })
    .catch((e: unknown) => {
      if (!(e instanceof Rollback)) throw e;
    });
}

export const inRollback = (
  fn: (trx: Transaction<DB>) => Promise<void>,
  conn: Kysely<DB> = db(),
): Promise<void> => rollbackWith("shared", fn, conn);

// A second concurrent connection inside a test that already holds the lock
// (the AC-1 race). Taking it again could queue behind a waiting DDL test,
// which is waiting on the first connection: a deadlock.
export const inRollbackNested = (
  fn: (trx: Transaction<DB>) => Promise<void>,
  conn: Kysely<DB> = db(),
): Promise<void> => rollbackWith("none", fn, conn);

// For a test that changes the schema (`applyBookingGapMigration`,
// `restoreOldOverlapRule`): waits for the running tests, then runs alone.
export const inRollbackDdl = (
  fn: (trx: Transaction<DB>) => Promise<void>,
  conn: Kysely<DB> = db(),
): Promise<void> => rollbackWith("exclusive", fn, conn);

// Code under test that opens its own `conn.transaction()` cannot run on a
// rollback transaction (Kysely refuses nesting). This view runs each such
// block on `trx` inside a savepoint: a block that throws undoes its own
// writes, as a real transaction would, and everything still rolls back with
// the test.
export function asConn(trx: Transaction<DB>): Kysely<DB> {
  return new Proxy(trx, {
    get(target, prop, receiver) {
      if (prop === "transaction")
        return () => {
          const builder = {
            // The rollback transaction is already open, so an isolation level
            // cannot change; code that asks for one (`readResetList`) runs.
            setIsolationLevel: () => builder,
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
          };
          return builder;
        };
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

// Spec 0020: the bookings_no_overlap rule with the cleanup gap. Runs the real
// migration inside the test transaction (Postgres DDL is transactional), so
// the shared database keeps its own constraint and the test rolls it back.
export async function applyBookingGapMigration(trx: Kysely<DB>): Promise<void> {
  const file = path.join(
    process.cwd(),
    "db/migrations/0016_booking_cleanup_gap.sql",
  );
  await sql.raw(await readFile(file, "utf8")).execute(trx);
}

// The rule before spec 0020: no gap. For a test that needs the old state,
// whatever the database has applied.
export async function restoreOldOverlapRule(trx: Kysely<DB>): Promise<void> {
  await sql`alter table hol_app.bookings drop constraint bookings_no_overlap`.execute(
    trx,
  );
  await sql`alter table hol_app.bookings add constraint bookings_no_overlap exclude using gist (
    testbed_id with =,
    tstzrange(starts_at, ends_at, '[)') with &&
  ) where (status in ('provisioning', 'confirmed'))`.execute(trx);
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
      // The Authentik group name (spec 0018), unique among live rows.
      group_name: `Group ${id}`,
      slug: `testbed-${id}`,
      // A live row needs a domain and a group pk (spec 0017 AC-11), each
      // unique among live rows.
      domain: `t-${id}.example.test`,
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
