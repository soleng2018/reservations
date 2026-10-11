import "server-only";
import { sql, type Kysely } from "kysely";
import type { TestbedTypeInput } from "@/lib/catalog-input";
import { changedFields } from "@/lib/changed-fields";
import { DurationUnit } from "@/lib/db-enums";
import type { Blocker } from "@/lib/delete-flow";
import { err, ok, type Result } from "@/lib/result";
import { audit } from "@/server/audit";
import { mapConstraintError } from "@/server/db/constraint-errors";
import {
  lockForDelete,
  testbedTypeBlockers,
} from "@/server/db/delete-blockers";
import type { DB } from "@/server/db/types";

export type TestbedTypeRow = {
  readonly id: string;
  readonly name: string;
  readonly durationValue: number;
  readonly durationUnit: DurationUnit;
  readonly testbedCount: number; // live testbeds of this type
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

// Feature 7. A new duration applies to new bookings and reschedules only:
// a booking keeps the ends_at it was given (spec 0002). The row lock waits
// for a booking that holds the type FOR SHARE. A duplicate name aborts the
// transaction, so it is mapped outside it.
export async function updateTestbedType(
  conn: Kysely<DB>,
  id: string,
  input: TestbedTypeInput,
  actorId: string,
): Promise<Result<void, "duplicate_name" | "not_found">> {
  try {
    return await conn.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom("testbed_types")
        .select(["name", "duration_value", "duration_unit"])
        .where("id", "=", id)
        .where("deleted_at", "is", null)
        .forUpdate()
        .executeTakeFirst();
      if (!row) return err("not_found");
      const changed = changedFields(
        ["name", "durationValue", "durationUnit"],
        {
          name: row.name,
          durationValue: row.duration_value,
          durationUnit: DurationUnit.parse(row.duration_unit),
        },
        input,
      );
      if (Object.keys(changed).length === 0) return ok(undefined);

      await trx
        .updateTable("testbed_types")
        .set({
          name: input.name,
          duration_value: input.durationValue,
          duration_unit: input.durationUnit,
        })
        .where("id", "=", id)
        .execute();
      await audit(trx, {
        actorUserId: actorId,
        action: "testbed_type.updated",
        targetType: "testbed_type",
        targetId: id,
        summary: "Testbed type updated",
        metadata: changed,
      });
      return ok(undefined);
    });
  } catch (e) {
    const mapped = mapConstraintError(e);
    if (!mapped.ok && mapped.error === "duplicate_name")
      return err("duplicate_name");
    throw e;
  }
}

export type DeleteTestbedTypeError =
  | { readonly kind: "blocked"; readonly blockers: readonly Blocker[] }
  | { readonly kind: "not_found" };

// Feature 7 (spec 0002 AC-4, AC-14). Lock, check the blockers again, then
// soft delete, so a testbed added meanwhile cannot slip in. The name is free
// for reuse afterwards (unique among live rows only).
export async function deleteTestbedType(
  conn: Kysely<DB>,
  id: string,
  actorId: string,
): Promise<Result<void, DeleteTestbedTypeError>> {
  return conn.transaction().execute(async (trx) => {
    if (!(await lockForDelete(trx, "testbed_types", id)))
      return err({ kind: "not_found" });
    const blockers = await testbedTypeBlockers(trx, id);
    if (blockers.length > 0) return err({ kind: "blocked", blockers });

    await trx
      .updateTable("testbed_types")
      .set({ deleted_at: sql<Date>`now()` })
      .where("id", "=", id)
      .execute();
    await audit(trx, {
      actorUserId: actorId,
      action: "testbed_type.deleted",
      targetType: "testbed_type",
      targetId: id,
      summary: "Testbed type deleted",
    });
    return ok(undefined);
  });
}

// Live types, by name, with how many live testbeds use each.
export async function listTestbedTypes(
  conn: Kysely<DB>,
): Promise<readonly TestbedTypeRow[]> {
  const rows = await conn
    .selectFrom("testbed_types")
    .select((eb) => [
      "id",
      "name",
      "duration_value",
      "duration_unit",
      eb
        .selectFrom("testbeds")
        .select(sql<number>`count(*)::int`.as("n"))
        .whereRef("testbeds.testbed_type_id", "=", "testbed_types.id")
        .where("testbeds.deleted_at", "is", null)
        .as("testbed_count"),
    ])
    .where("deleted_at", "is", null)
    .orderBy(sql`lower(name)`)
    .execute();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    durationValue: r.duration_value,
    durationUnit: DurationUnit.parse(r.duration_unit),
    testbedCount: r.testbed_count ?? 0,
  }));
}
