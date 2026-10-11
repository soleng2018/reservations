import "server-only";
import type { Kysely } from "kysely";
import { audit } from "@/server/audit";
import type { DB } from "@/server/db/types";

// Spec 0008 AC-3: the console learns an admin's timezone once, from their
// browser, while their row still holds the default UTC. Only an admin row
// changes, and the audit row is written only when it did.
export async function setAdminTimezone(
  conn: Kysely<DB>,
  adminId: string,
  zone: string,
): Promise<boolean> {
  return conn.transaction().execute(async (trx) => {
    const row = await trx
      .updateTable("users")
      .set({ timezone: zone })
      .where("id", "=", adminId)
      .where("role", "=", "admin")
      .where("timezone", "=", "UTC")
      .returning("id")
      .executeTakeFirst();
    if (!row) return false;
    await audit(trx, {
      actorUserId: adminId,
      action: "admin.timezone_set",
      targetType: "user",
      targetId: adminId,
      summary: "Admin timezone set from the browser",
      metadata: { to: zone },
    });
    return true;
  });
}
