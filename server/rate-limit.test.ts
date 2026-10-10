import type { Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import { dbNow } from "@/server/db/bookings";
import { hasDb, inRollback } from "@/server/db/testing";
import type { DB } from "@/server/db/types";
import { countAttempt, countHourlyAttempt } from "./rate-limit";

const key = () => `test:${crypto.randomUUID()}`;

describe.skipIf(!hasDb)("countHourlyAttempt (AC-8)", () => {
  it("allows up to the limit, then refuses, counting every attempt", () =>
    inRollback(async (trx) => {
      const bucket = key();
      const results = [];
      for (let i = 0; i < 5; i++)
        results.push(await countHourlyAttempt(trx, bucket, 3));
      expect(results).toEqual([true, true, true, false, false]);

      const row = await trx
        .selectFrom("rate_limits")
        .select("count")
        .where("bucket_key", "=", bucket)
        .executeTakeFirstOrThrow();
      expect(row.count).toBe(5);
    }));

  it("keeps each bucket key separate", () =>
    inRollback(async (trx) => {
      const a = key();
      const b = key();
      await countHourlyAttempt(trx, a, 1);
      expect(await countHourlyAttempt(trx, a, 1)).toBe(false);
      expect(await countHourlyAttempt(trx, b, 1)).toBe(true);
    }));
});

// covers: spec 0004 AC-4 (5 tries per 10 minute window per IP, then refused)
describe.skipIf(!hasDb)("countAttempt (spec 0004 AC-4)", () => {
  const windowStart = (trx: Kysely<DB>, bucket: string) =>
    trx
      .selectFrom("rate_limits")
      .select("window_start")
      .where("bucket_key", "=", bucket)
      .execute();

  it("refuses the 6th try in a 10 minute window", () =>
    inRollback(async (trx) => {
      const bucket = key();
      const results = [];
      for (let i = 0; i < 6; i++)
        results.push(await countAttempt(trx, bucket, 5, 600));
      expect(results).toEqual([true, true, true, true, true, false]);
    }));

  it("starts the window on a multiple of its length, by the DB clock", () =>
    inRollback(async (trx) => {
      const bucket = key();
      await countAttempt(trx, bucket, 5, 600);
      const now = await dbNow(trx);
      const rows = await windowStart(trx, bucket);
      expect(rows).toHaveLength(1);
      const start = rows[0]?.window_start.getTime() ?? NaN;
      expect(start % 600_000).toBe(0);
      expect(start).toBeLessThanOrEqual(now.getTime());
      expect(now.getTime() - start).toBeLessThan(600_000);
    }));

  it("keeps the hourly helper on an hour boundary", () =>
    inRollback(async (trx) => {
      const bucket = key();
      await countHourlyAttempt(trx, bucket, 1);
      const [row] = await windowStart(trx, bucket);
      expect((row?.window_start.getTime() ?? NaN) % 3_600_000).toBe(0);
    }));
});
