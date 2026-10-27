import { sql, type Transaction } from "kysely";
import { afterAll, describe, expect, it } from "vitest";
import { asConn, hasDb, inRollback, makeUser } from "@/server/db/testing";
import { db } from "@/server/db";
import type { DB } from "@/server/db/types";
import { seedPortalReset } from "./seed";
import { readResetList, readResetPage } from "./steps";

const seeded = async (trx: Transaction<DB>) => {
  await trx.deleteFrom("portal_reset_steps").execute();
  await trx
    .updateTable("portal_reset_settings")
    .set({ seeded_at: null })
    .execute();
  await seedPortalReset(asConn(trx));
};

afterAll(() => db().destroy());

describe.skipIf(!hasDb)("readResetList (AC-16)", () => {
  it("returns the settings and the steps in order", async () => {
    await inRollback(async (trx) => {
      await seeded(trx);
      await trx
        .updateTable("portal_reset_settings")
        .set({ abort_email: "ops@example.com", mode: "dry_run", version: 4 })
        .execute();
      const list = await readResetList(asConn(trx));
      expect(list).toMatchObject({
        version: 4,
        abortEmail: "ops@example.com",
        mode: "dry_run",
      });
      expect(list.steps.map((s) => (s.ok ? s.step.position : -1))).toEqual(
        Array.from({ length: 13 }, (_, i) => i + 1),
      );
      expect(Object.keys(list).sort()).toEqual([
        "abortEmail",
        "mode",
        "steps",
        "version",
      ]);
    });
  });

  it("parses each definition on the way out and keeps the enabled flag (AC-21)", async () => {
    await inRollback(async (trx) => {
      await seeded(trx);
      const list = await readResetList(asConn(trx));
      const profiles = list.steps.find(
        (s) => s.ok && s.step.seedKey === "service-profiles",
      );
      expect(profiles?.ok && profiles.step.enabled).toBe(false);
      const ssids = list.steps.find((s) => s.ok && s.step.seedKey === "ssids");
      expect(ssids?.ok && ssids.step.definition.parts[0]?.kind).toBe(
        "delete_each",
      );
    });
  });

  it("returns a row with a broken definition as { ok: false }, in place", async () => {
    await inRollback(async (trx) => {
      await seeded(trx);
      await sql`update hol_app.portal_reset_steps set definition = '{"parts": []}' where position = 2`.execute(
        trx,
      );
      const list = await readResetList(asConn(trx));
      expect(list.steps).toHaveLength(13);
      expect(list.steps[1]).toMatchObject({
        ok: false,
        position: 2,
        featureName: "SSIDs",
        error: "invalid_definition",
      });
      expect(list.steps[0]?.ok).toBe(true);
      expect(list.steps[2]?.ok).toBe(true);
    });
  });

  it("returns an empty list, not an error, when the table is empty", async () => {
    await inRollback(async (trx) => {
      await trx.deleteFrom("portal_reset_steps").execute();
      const list = await readResetList(asConn(trx));
      expect(list.steps).toEqual([]);
    });
  });
});

describe.skipIf(!hasDb)("readResetPage", () => {
  it("has no last saved by before the first Save", async () => {
    await inRollback(async (trx) => {
      await trx
        .updateTable("portal_reset_settings")
        .set({ updated_by: null })
        .execute();
      expect((await readResetPage(asConn(trx))).updatedByName).toBeNull();
    });
  });

  it("names the admin who saved last", async () => {
    await inRollback(async (trx) => {
      const admin = await makeUser(trx, { role: "admin", name: "Maria Admin" });
      await trx
        .updateTable("portal_reset_settings")
        .set({ updated_by: admin.id })
        .execute();
      expect((await readResetPage(asConn(trx))).updatedByName).toBe(
        "Maria Admin",
      );
    });
  });
});
