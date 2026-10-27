import "server-only";
import { sql, type Kysely } from "kysely";
import { audit } from "@/server/audit";
import type { DB } from "@/server/db/types";
import { startingList } from "./starting-list";

export type SeedResult =
  | { readonly seeded: false }
  | { readonly seeded: true; readonly inserted: readonly string[] };

// Loads the starting list once (spec 0022 AC-1, AC-2). The marker
// `seeded_at`, not an empty table, decides: an admin may empty the list on
// purpose, and a later deploy must never bring rows back. The settings row is
// locked first, so two migrates at once insert once. A table that already
// holds rows (a dev database) gets none, only the marker.
export async function seedPortalReset(
  conn: Kysely<DB>,
  list = startingList(),
): Promise<SeedResult> {
  return conn.transaction().execute(async (trx) => {
    const settings = await trx
      .selectFrom("portal_reset_settings")
      .select("seeded_at")
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (settings.seeded_at !== null) return { seeded: false };

    const { rows } = await sql<{ n: number }>`
      select count(*)::int as n from hol_app.portal_reset_steps`.execute(trx);
    const empty = rows[0]?.n === 0;
    const entries = empty ? list.steps : [];
    if (entries.length > 0) {
      await trx
        .insertInto("portal_reset_steps")
        .values(
          entries.map((entry, i) => ({
            position: i + 1,
            feature_name: entry.featureName,
            enabled: entry.enabled,
            definition: JSON.stringify(entry.definition),
            note: entry.note,
            seed_key: entry.key,
          })),
        )
        .execute();
    }
    await trx
      .updateTable("portal_reset_settings")
      .set({ seeded_at: sql`now()` })
      .execute();
    const inserted = entries.map((e) => e.key);
    await audit(trx, {
      actorUserId: null,
      action: "portal_reset.seeded",
      targetType: "portal_reset_settings",
      targetId: "settings",
      summary: `Seeded ${inserted.length} steps from the starting list`,
      metadata: { count: inserted.length, keys: inserted },
    });
    return { seeded: true, inserted };
  });
}
