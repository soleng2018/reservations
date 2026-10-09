import "server-only";
import { sql, type Kysely } from "kysely";
import type { TestbedTypeInput } from "@/lib/catalog-input";
import { DurationUnit } from "@/lib/db-enums";
import { err, ok, type Result } from "@/lib/result";
import { audit } from "@/server/audit";
import type { DB } from "@/server/db/types";

export type TestbedTypeRow = {
  readonly id: string;
  readonly name: string;
  readonly durationValue: number;
  readonly durationUnit: DurationUnit;
};

// AC-1. A live type with the same name ignoring case is refused through
// testbed_types_name_lower_uq (ON CONFLICT DO NOTHING, so no aborted
// transaction to map).
export async function createTestbedType(
  conn: Kysely<DB>,
  input: TestbedTypeInput,
  actorId: string,
): Promise<Result<{ readonly id: string }, "duplicate_name">> {
  return conn.transaction().execute(async (trx) => {
    const row = await trx
      .insertInto("testbed_types")
      .values({
        name: input.name,
        duration_value: input.durationValue,
        duration_unit: input.durationUnit,
      })
      .onConflict((oc) => oc.doNothing())
      .returning("id")
      .executeTakeFirst();
    if (!row) return err("duplicate_name");
    await audit(trx, {
      actorUserId: actorId,
      action: "testbed_type.created",
      targetType: "testbed_type",
      targetId: row.id,
      summary: "Testbed type created",
      metadata: {
        durationValue: input.durationValue,
        durationUnit: input.durationUnit,
      },
    });
    return ok(row);
  });
}

// Live types, by name.
export async function listTestbedTypes(
  conn: Kysely<DB>,
): Promise<readonly TestbedTypeRow[]> {
  const rows = await conn
    .selectFrom("testbed_types")
    .select(["id", "name", "duration_value", "duration_unit"])
    .where("deleted_at", "is", null)
    .orderBy(sql`lower(name)`)
    .execute();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    durationValue: r.duration_value,
    durationUnit: DurationUnit.parse(r.duration_unit),
  }));
}
