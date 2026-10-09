import "server-only";
import { sql, type Kysely } from "kysely";
import type { DB } from "@/server/db/types";

// Fixed window buckets in `rate_limits` (spec 0002 shape, spec 0004 windows).
// The window starts on a multiple of `windowSeconds` since the epoch, by the
// DB clock. Every attempt counts, allowed or not. True while the bucket is
// within `limit`.
export async function countAttempt(
  conn: Kysely<DB>,
  bucketKey: string,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  const row = await conn
    .insertInto("rate_limits")
    .values({
      bucket_key: bucketKey,
      window_start: sql<Date>`to_timestamp(floor(extract(epoch from now()) / ${windowSeconds}) * ${windowSeconds})`,
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

export const countHourlyAttempt = (
  conn: Kysely<DB>,
  bucketKey: string,
  limit: number,
): Promise<boolean> => countAttempt(conn, bucketKey, limit, 3600);
