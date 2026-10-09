import "server-only";
import { Client, type ClientBase } from "pg";
import type { DbEnv } from "@/server/env";

// Only one worker runs (spec 0004 AC-11): a session advisory lock held on a
// dedicated client for the life of the process, never a pooled connection,
// which would hand the lock's session to other work or drop it.

export function lockClient(env: DbEnv): Client {
  return new Client({
    host: env.DATABASE_HOST,
    port: env.DATABASE_PORT,
    database: env.DATABASE_NAME,
    user: env.DATABASE_USER,
    password: env.DATABASE_PASSWORD,
    connectionTimeoutMillis: 5_000,
    application_name: "hol-worker-lock",
  });
}

export async function tryWorkerLock(
  client: ClientBase,
  key: number,
): Promise<boolean> {
  const { rows } = await client.query<{ locked: boolean }>(
    "select pg_try_advisory_lock($1) as locked",
    [key],
  );
  return rows[0]?.locked === true;
}
