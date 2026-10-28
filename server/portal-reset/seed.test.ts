import { sql, type Transaction } from "kysely";
import { afterAll, describe, expect, it } from "vitest";
import { StartingList } from "@/lib/portal-reset/starting-list";
import { db } from "@/server/db";
import {
  asConn,
  hasDb,
  inRollback,
  inRollbackNested,
} from "@/server/db/testing";
import type { DB } from "@/server/db/types";
import { seedPortalReset } from "./seed";
import { startingList } from "./starting-list";

// A database as it is before the first seed: marker unset, no rows.
const unseeded = async (trx: Transaction<DB>) => {
  await trx.deleteFrom("portal_reset_steps").execute();
  await trx
    .updateTable("portal_reset_settings")
    .set({ seeded_at: null, version: 1, mode: "off" })
    .execute();
};

const steps = (trx: Transaction<DB>) =>
  trx
    .selectFrom("portal_reset_steps")
    .selectAll()
    .orderBy("position")
    .execute();

describe.skipIf(!hasDb)("seedPortalReset", () => {
  afterAll(() => db().destroy());

  it("AC-1: loads the file in order, numbered 1 to N, with mode off", async () => {
    await inRollback(async (trx) => {
      await unseeded(trx);
      const result = await seedPortalReset(asConn(trx));
      const list = startingList();
      expect(result).toEqual({
        seeded: true,
        inserted: list.steps.map((s) => s.key),
      });

      const rows = await steps(trx);
      expect(rows.map((r) => r.position)).toEqual(
        list.steps.map((_, i) => i + 1),
      );
      expect(rows.map((r) => r.seed_key)).toEqual(list.steps.map((s) => s.key));
      expect(rows.map((r) => r.enabled)).toEqual(
        list.steps.map((s) => s.enabled),
      );
      expect(rows.map((r) => r.feature_name)).toEqual(
        list.steps.map((s) => s.featureName),
      );
      rows.forEach((row, i) =>
        expect(row.definition).toEqual(
          JSON.parse(JSON.stringify(list.steps[i]?.definition)),
        ),
      );

      const settings = await trx
        .selectFrom("portal_reset_settings")
        .selectAll()
        .executeTakeFirstOrThrow();
      expect(settings.seeded_at).not.toBeNull();
      expect(settings).toMatchObject({
        mode: "off",
        version: 1,
        abort_email: null,
      });
    });
  });

  it("AC-1: every stored definition parses against the step language", async () => {
    await inRollback(async (trx) => {
      await unseeded(trx);
      await seedPortalReset(asConn(trx));
      const rows = await steps(trx);
      const file = {
        schemaVersion: 1,
        steps: rows.map((r) => ({
          key: r.seed_key,
          featureName: r.feature_name,
          enabled: r.enabled,
          ...(r.note === null ? {} : { note: r.note }),
          ...(r.definition as object),
        })),
      };
      expect(StartingList.safeParse(file).success).toBe(true);
    });
  });

  it("writes one seeded audit row by the system, with the keys and no actor", async () => {
    await inRollback(async (trx) => {
      await unseeded(trx);
      await seedPortalReset(asConn(trx));
      const rows = await trx
        .selectFrom("audit_events")
        .selectAll()
        .where("action", "=", "portal_reset.seeded")
        .orderBy("created_at", "desc")
        .limit(1)
        .execute();
      expect(rows[0]).toMatchObject({
        actor_user_id: null,
        target_type: "portal_reset_settings",
        target_id: "settings",
        summary: "Seeded 13 steps from the starting list",
      });
      expect(rows[0]?.metadata).toMatchObject({ count: 13 });
    });
  });

  it("AC-2: a second seed changes nothing", async () => {
    await inRollback(async (trx) => {
      await unseeded(trx);
      await seedPortalReset(asConn(trx));
      const before = await steps(trx);
      expect(await seedPortalReset(asConn(trx))).toEqual({ seeded: false });
      expect(await steps(trx)).toEqual(before);
    });
  });

  // Never commits (spec 0002): a second connection cannot see the first one's
  // uncommitted work, so this proves the race by blocking. Seed takes the
  // settings row lock before it reads `seeded_at`, so a second seed waits on
  // the first (lock_timeout 55P03) instead of reading the old marker and
  // inserting again. A read before the lock would not wait.
  it("AC-2: two seeds at once, the second waits on the first's lock", () =>
    inRollback(async (a) => {
      await unseeded(a);
      await seedPortalReset(asConn(a));
      const fromB = await inRollbackNested(async (b) => {
        await sql`set local lock_timeout = '300ms'`.execute(b);
        await seedPortalReset(asConn(b));
      }).then(
        () => undefined,
        (e: unknown) => (e as { code?: string }).code,
      );
      expect(fromB).toBe("55P03");
    }));

  it("AC-2: after an admin emptied the list, a seed brings nothing back", async () => {
    await inRollback(async (trx) => {
      await unseeded(trx);
      await seedPortalReset(asConn(trx));
      await trx.deleteFrom("portal_reset_steps").execute();
      expect(await seedPortalReset(asConn(trx))).toEqual({ seeded: false });
      expect(await steps(trx)).toEqual([]);
    });
  });

  it("AC-2: a file that gained an entry adds nothing once seeded", async () => {
    await inRollback(async (trx) => {
      await unseeded(trx);
      await seedPortalReset(asConn(trx));
      const list = startingList();
      const [first] = list.steps;
      if (!first) throw new Error("the starting list is empty");
      const longer = {
        ...list,
        steps: [
          ...list.steps,
          { ...first, key: "extra", featureName: "Extra" },
        ],
      };
      expect(await seedPortalReset(asConn(trx), longer)).toEqual({
        seeded: false,
      });
      expect(await steps(trx)).toHaveLength(list.steps.length);
    });
  });

  it("a table that already holds rows gets none, only the marker", async () => {
    await inRollback(async (trx) => {
      await unseeded(trx);
      await trx
        .insertInto("portal_reset_steps")
        .values({
          position: 1,
          feature_name: "Mine",
          definition: JSON.stringify({ parts: [{ kind: "wait", seconds: 1 }] }),
        })
        .execute();
      const result = await seedPortalReset(asConn(trx));
      expect(result).toEqual({ seeded: true, inserted: [] });
      expect((await steps(trx)).map((r) => r.feature_name)).toEqual(["Mine"]);
      const { rows } = await sql<{ set: boolean }>`
        select seeded_at is not null as set from hol_app.portal_reset_settings`.execute(
        trx,
      );
      expect(rows[0]?.set).toBe(true);
    });
  });
});
