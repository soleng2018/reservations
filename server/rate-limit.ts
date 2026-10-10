import "server-only";
import { sql, type Kysely } from "kysely";
import type { DB } from "@/server/db/types";

// Fixed hourly buckets in `rate_limits` (spec 0002 shape). Every attempt
// counts, allowed or not. True while the bucket is within `limit`.
export async function countHourlyAttempt(
  conn: Kysely<DB>,
  bucketKey: string,
  limit: number,
): Promise<boolean> {
  const row = await conn
    .insertInto("rate_limits")
    .values({
      bucket_key: bucketKey,
      window_start: sql<Date>`date_trunc('hour', now())`,
      count: 1,
    })
    .onConflict((oc) =>
      oc
        .columns(["bucket_key", "window_start"])
        .doUpdateSet({ count: sql<number>`rate_limits.count + 1` }),
    )
    .returning("count")
    .executeTakeFirstOrThrow();
  return row.count <= limit;
}
