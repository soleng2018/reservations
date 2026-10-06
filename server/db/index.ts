import "server-only";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { dbEnv } from "@/server/env";
import type { DB } from "./types";

let instance: Kysely<DB> | undefined;

// One pg Pool per process, created on first use.
export function db(): Kysely<DB> {
  if (!instance) {
    const env = dbEnv();
    const pool = new Pool({
      host: env.DATABASE_HOST,
      port: env.DATABASE_PORT,
      database: env.DATABASE_NAME,
      user: env.DATABASE_USER,
      password: env.DATABASE_PASSWORD,
      max: 10,
    });
    instance = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  }
  return instance;
}
