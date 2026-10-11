import { describe, expect, it } from "vitest";
import { asConn, hasDb, inRollback, makeUser } from "@/server/db/testing";
import { setAdminTimezone } from "./admin-timezone";

// covers: AC-3, AC-13
describe.skipIf(!hasDb)("setAdminTimezone (spec 0008 AC-3)", () => {
  it("stores the zone once, only on a UTC admin row, and audits it", () =>
    inRollback(async (trx) => {
      const admin = await makeUser(trx, { role: "admin", timezone: "UTC" });
      const learner = await makeUser(trx, { timezone: "UTC" });
      const conn = asConn(trx);

      expect(await setAdminTimezone(conn, admin.id, "Europe/Paris")).toBe(true);
      expect(await setAdminTimezone(conn, admin.id, "Asia/Tokyo")).toBe(false);
      expect(await setAdminTimezone(conn, learner.id, "Asia/Tokyo")).toBe(
        false,
      );

      const zones = await trx
        .selectFrom("users")
        .select(["id", "timezone"])
        .where("id", "in", [admin.id, learner.id])
        .execute();
      expect(zones).toEqual(
        expect.arrayContaining([
          { id: admin.id, timezone: "Europe/Paris" },
          { id: learner.id, timezone: "UTC" },
        ]),
      );
      const audits = await trx
        .selectFrom("audit_events")
        .select(["action", "actor_user_id", "metadata"])
        .where("target_id", "in", [admin.id, learner.id])
        .execute();
      expect(audits).toEqual([
        {
          action: "admin.timezone_set",
          actor_user_id: admin.id,
          metadata: { to: "Europe/Paris" },
        },
      ]);
    }));
});
