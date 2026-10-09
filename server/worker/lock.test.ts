import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hasDb } from "@/server/db/testing";
import { dbEnv } from "@/server/env";
import { lockClient, tryWorkerLock } from "./lock";

// covers: AC-11
describe.skipIf(!hasDb)("worker lock (AC-11)", () => {
  it("lets one client hold the lock and refuses a second", async () => {
    // A random key, so a real worker holding the real key is never touched.
    const key = Math.floor(Math.random() * 1_000_000_000) + 1;
    const first = lockClient(dbEnv());
    const second = lockClient(dbEnv());
    await Promise.all([first.connect(), second.connect()]);
    try {
      expect(await tryWorkerLock(first, key)).toBe(true);
      expect(await tryWorkerLock(second, key)).toBe(false);
      // A session lock: still held by `first` across statements, which
      // proves DATABASE_* reaches Postgres directly, not a transaction pooler.
      const { rows } = await second.query<{ holder: number }>(
        "select pid as holder from pg_locks where locktype = 'advisory' and objid = $1",
        [key],
      );
      const { rows: me } = await first.query<{ pid: number }>(
        "select pg_backend_pid() as pid",
      );
      expect(rows.map((r) => r.holder)).toEqual([me[0]?.pid]);
    } finally {
      await first.query("select pg_advisory_unlock_all()");
      await Promise.all([first.end(), second.end()]);
    }
  });
});

describe("npm run worker", () => {
  it("exits 0 without starting unless WORKER_ENABLED is true", () => {
    const root = path.resolve(__dirname, "../..");
    const run = spawnSync(
      "npx",
      ["tsx", "--conditions=react-server", "worker/index.ts"],
      {
        cwd: root,
        env: { ...process.env, WORKER_ENABLED: "false" },
        encoding: "utf8",
        timeout: 60_000,
      },
    );
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("WORKER_ENABLED is not true");
  }, 70_000);
});
