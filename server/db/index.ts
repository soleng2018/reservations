import "server-only";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { dbEnv, type DbEnv } from "@/server/env";
import type { DB } from "./types";

export function createDb<T = DB>(env: DbEnv, max: number): Kysely<T> {
  const pool = new Pool({
    host: env.DATABASE_HOST,
    port: env.DATABASE_PORT,
    database: env.DATABASE_NAME,
    user: env.DATABASE_USER,
    password: env.DATABASE_PASSWORD,
    max,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
  // An idle client dropping (e.g. InsForge restart) emits `error` on the pool;
  // unhandled, it would crash the process. The pool discards that client.
  pool.on("error", (err) => console.error("pg pool: idle client error", err));
  return new Kysely<T>({ dialect: new PostgresDialect({ pool }) });
}

// Cached on globalThis so dev hot reloads reuse one pool instead of leaking one
// per reload against the shared database.
const cache = globalThis as typeof globalThis & { holDb?: Kysely<DB> };

// One pg Pool per process, created on first use.
export function db(): Kysely<DB> {
  cache.holDb ??= createDb(dbEnv(), 10);
  return cache.holDb;
}
