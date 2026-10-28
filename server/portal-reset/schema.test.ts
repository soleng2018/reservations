import { sql, type Transaction } from "kysely";
import { afterAll, describe, expect, it } from "vitest";
import { jsonbTextBytes } from "@/lib/portal-reset/step-schema";
import { db } from "@/server/db";
import { mapConstraintError } from "@/server/db/constraint-errors";
import { hasDb, inRollback } from "@/server/db/testing";
import type { DB } from "@/server/db/types";

const wait = { parts: [{ kind: "wait", seconds: 1 }] };

const clear = (trx: Transaction<DB>) =>
  trx.deleteFrom("portal_reset_steps").execute();

const step = (
  trx: Transaction<DB>,
  position: number,
  featureName: string,
  extra: Partial<{ seed_key: string; definition: unknown }> = {},
) =>
  trx
    .insertInto("portal_reset_steps")
    .values({
      position,
      feature_name: featureName,
      definition: JSON.stringify(extra.definition ?? wait),
      ...(extra.seed_key === undefined ? {} : { seed_key: extra.seed_key }),
    })
    .execute();

// Spec 0022 data model: the constraints the Save and the seed rely on.
describe.skipIf(!hasDb)("portal reset tables", () => {
  afterAll(() => db().destroy());

  // The version only goes up (a Save raises it), so it is not pinned to 1.
  it("has exactly one settings row, with a version", async () => {
    await inRollback(async (trx) => {
      const rows = await trx
        .selectFrom("portal_reset_settings")
        .selectAll()
        .execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: true });
      expect(rows[0]?.version).toBeGreaterThanOrEqual(1);
    });
  });

  it("refuses a second settings row", async () => {
    await inRollback(async (trx) => {
      const second = sql`insert into hol_app.portal_reset_settings (id) values (false)`;
      await expect(second.execute(trx)).rejects.toMatchObject({
        constraint: "portal_reset_settings_single_row",
      });
    });
  });

  it.each([
    [
      "a mode outside the list",
      sql`update hol_app.portal_reset_settings set mode = 'on'`,
      "portal_reset_settings_mode_check",
    ],
    [
      "a version below 1",
      sql`update hol_app.portal_reset_settings set version = 0`,
      "portal_reset_settings_version_check",
    ],
    [
      "an email over 254 characters",
      sql`update hol_app.portal_reset_settings set abort_email = ${"a".repeat(255)}`,
      "portal_reset_settings_abort_email_check",
    ],
  ])("refuses %s", async (_why, statement, constraint) => {
    await inRollback(async (trx) => {
      await expect(statement.execute(trx)).rejects.toMatchObject({
        constraint,
      });
    });
  });

  it("lets a reorder swap two positions inside one transaction", async () => {
    await inRollback(async (trx) => {
      await clear(trx);
      await step(trx, 1, "A");
      await step(trx, 2, "B");
      await sql`update hol_app.portal_reset_steps set position = 3 - position`.execute(
        trx,
      );
      await sql`set constraints all immediate`.execute(trx);
      const rows = await trx
        .selectFrom("portal_reset_steps")
        .select(["feature_name", "position"])
        .orderBy("position")
        .execute();
      expect(rows.map((r) => r.feature_name)).toEqual(["B", "A"]);
    });
  });

  it("refuses a repeated position when the transaction ends", async () => {
    await inRollback(async (trx) => {
      await clear(trx);
      await step(trx, 1, "A");
      await step(trx, 1, "B");
      await expect(
        sql`set constraints all immediate`.execute(trx),
      ).rejects.toMatchObject({ constraint: "portal_reset_steps_position_uq" });
    });
  });

  it("refuses a feature name repeated ignoring case, and maps it", async () => {
    await inRollback(async (trx) => {
      await clear(trx);
      await step(trx, 1, "SSIDs");
      const again = await step(trx, 2, "ssids").then(
        () => null,
        (e: unknown) => e,
      );
      expect(mapConstraintError(again)).toEqual({
        ok: false,
        error: "duplicate_name",
      });
    });
  });

  it("refuses a seed key used twice, and maps it, but allows many nulls", async () => {
    await inRollback(async (trx) => {
      await clear(trx);
      await step(trx, 1, "A", { seed_key: "ssids" });
      await step(trx, 2, "B");
      await step(trx, 3, "C");
      const again = await step(trx, 4, "D", { seed_key: "ssids" }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(mapConstraintError(again)).toEqual({
        ok: false,
        error: "duplicate_step",
      });
    });
  });

  it("refuses a name of 0 or 61 characters, a note over 300, and a non object definition", async () => {
    await inRollback(async (trx) => {
      await clear(trx);
      await expect(step(trx, 1, "")).rejects.toMatchObject({
        constraint: "portal_reset_steps_feature_name_check",
      });
    });
    await inRollback(async (trx) => {
      await expect(step(trx, 1, "x".repeat(61))).rejects.toMatchObject({
        constraint: "portal_reset_steps_feature_name_check",
      });
    });
    await inRollback(async (trx) => {
      await expect(
        sql`insert into hol_app.portal_reset_steps (position, feature_name, definition, note)
            values (1, 'N', '{}', ${"n".repeat(301)})`.execute(trx),
      ).rejects.toMatchObject({ constraint: "portal_reset_steps_note_check" });
    });
    await inRollback(async (trx) => {
      await expect(
        sql`insert into hol_app.portal_reset_steps (position, feature_name, definition)
            values (1, 'N', '[]')`.execute(trx),
      ).rejects.toMatchObject({
        constraint: "portal_reset_steps_definition_check",
      });
    });
  });

  it("measures a definition's size the way the schema does", async () => {
    await inRollback(async (trx) => {
      await clear(trx);
      const body = { a: ["x", 1, null, true], b: { é: "ü" } };
      const definition = {
        parts: [{ kind: "call", method: "PUT", path: "/api/v1/x", body }],
      };
      await step(trx, 1, "Size", { definition });
      const { rows } = await sql<{ n: number }>`
        select octet_length(definition::text)::int as n
        from hol_app.portal_reset_steps`.execute(trx);
      expect(rows[0]?.n).toBe(jsonbTextBytes(definition));
    });
  });

  it("refuses a definition over 20 000 bytes", async () => {
    await inRollback(async (trx) => {
      await clear(trx);
      const big = {
        parts: [{ kind: "wait", seconds: 1 }],
        pad: "x".repeat(20_000),
      };
      await expect(
        step(trx, 1, "Big", { definition: big }),
      ).rejects.toMatchObject({
        constraint: "portal_reset_steps_definition_size_check",
      });
    });
  });

  it("accepts the two new audit target types", async () => {
    await inRollback(async (trx) => {
      await sql`insert into hol_app.audit_events (action, target_type, target_id, summary)
        values ('portal_reset.saved', 'portal_reset_settings', 'settings', 'x'),
               ('portal_reset.step_added', 'portal_reset_step', gen_random_uuid()::text, 'x')`.execute(
        trx,
      );
    });
  });
});
