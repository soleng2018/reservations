import { describe, expect, it } from "vitest";
import { hasDb, inRollback } from "@/server/db/testing";
import { countHourlyAttempt } from "./rate-limit";

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
