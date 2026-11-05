import "server-only";
import { sql, type Kysely } from "kysely";
import type { TestbedTypeInput } from "@/lib/catalog-input";
import { changedFields } from "@/lib/changed-fields";
import { DurationUnit } from "@/lib/db-enums";
import type { Blocker } from "@/lib/delete-flow";
import { err, type Result } from "@/lib/result";
import { audit } from "@/server/audit";
import { mapConstraintError } from "@/server/db/constraint-errors";
import {
  lockForDelete,
  testbedTypeBlockers,
} from "@/server/db/delete-blockers";
import type { DB } from "@/server/db/types";
import { Refusal, refusable } from "@/server/db/refusal";
import { authentik, type CoreApi } from "@/server/authentik/client";
import {
  deleteTypeGroup,
  ensureTypeGroup,
  renameTypeGroup,
} from "@/server/authentik/type-groups";

export type TestbedTypeRow = {
  readonly id: string;
  readonly name: string;
  readonly durationValue: number;
  readonly durationUnit: DurationUnit;
  readonly testbedCount: number; // live testbeds of this type
};

export type CreateTypeError =
  | "duplicate_name"
  | "group_unusable"
  | "group_in_use"
  | "group_bad_name"
  | "unavailable";

// Spec 0026 AC-1 to AC-4. A live type with the same name ignoring case is
// refused through testbed_types_name_lower_uq (ON CONFLICT DO NOTHING, so no
// aborted transaction to map). The type's Authentik group is made or linked
// inside the same transaction, so a refusal rolls the row back.
export async function createTestbedType(
  conn: Kysely<DB>,
  input: TestbedTypeInput,
  actorId: string,
  api?: CoreApi,
): Promise<Result<{ readonly id: string }, CreateTypeError>> {
  try {
    return await refusable<{ readonly id: string }, CreateTypeError>(() =>
      conn.transaction().execute(async (trx) => {
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
        if (!row) throw new Refusal<CreateTypeError>("duplicate_name");
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

        const group = await ensureTypeGroup(api ?? authentik(), {
          typeId: row.id,
          name: input.name,
        });
        if (!group.ok)
          throw new Refusal<CreateTypeError>(
            group.error === "unsafe"
              ? "group_unusable"
              : groupFailure(group.error),
          );
        if (group.value.outcome === "linked") {
          const held = await trx
            .selectFrom("testbed_types")
            .select("id")
            .where("authentik_group_pk", "=", group.value.pk)
            .where("deleted_at", "is", null)
            .executeTakeFirst();
          if (held) throw new Refusal<CreateTypeError>("group_in_use");
        }
        await trx
          .updateTable("testbed_types")
          .set({
            authentik_group_pk: group.value.pk,
            authentik_group_origin: group.value.origin,
          })
          .where("id", "=", row.id)
          .execute();
        await audit(trx, {
          actorUserId: actorId,
          action:
            group.value.outcome === "created"
              ? "authentik_group.created"
              : "authentik_group.linked",
          targetType: "testbed_type",
          targetId: row.id,
          summary:
            group.value.outcome === "created"
              ? "Authentik group created for a testbed type"
              : "Authentik group linked to a testbed type",
          metadata: { groupPk: group.value.pk },
        });
        return { id: row.id };
      }),
    );
  } catch (e) {
    // testbed_types_group_pk_uq: the backstop behind the check above.
    const mapped = mapConstraintError(e);
    if (!mapped.ok && mapped.error === "group_in_use")
      return err("group_in_use");
    throw e;
  }
}

const groupFailure = (
  e: "name_invalid" | "unavailable",
): "group_bad_name" | "unavailable" =>
  e === "name_invalid" ? "group_bad_name" : "unavailable";

export type UpdateTypeError =
  | "duplicate_name"
  | "not_found"
  | "group_clash"
  | "group_changed"
  | "group_bad_name"
  | "unavailable";

// "group_kept": the type is linked to a group the owner made, which keeps its
// old name (AC-7).
export type UpdateTypeOutcome = { readonly note: "group_kept" | null };

// Feature 7, spec 0026 AC-5 to AC-8. A new duration applies to new bookings
// and reschedules only: a booking keeps the ends_at it was given (spec 0002).
// The row lock waits for a booking that holds the type FOR SHARE. A duplicate
// name aborts the transaction, so it is mapped outside it. A changed name
// renames the group the app made (after the row update, so `duplicate_name`
// wins); a type with no group yet, or a reused one, makes no Authentik call.
export async function updateTestbedType(
  conn: Kysely<DB>,
  id: string,
  input: TestbedTypeInput,
  actorId: string,
  api?: CoreApi,
): Promise<Result<UpdateTypeOutcome, UpdateTypeError>> {
  try {
    return await refusable<UpdateTypeOutcome, UpdateTypeError>(() =>
      conn.transaction().execute(async (trx) => {
        const row = await trx
          .selectFrom("testbed_types")
          .select([
            "name",
            "duration_value",
            "duration_unit",
            "authentik_group_pk",
            "authentik_group_origin",
          ])
          .where("id", "=", id)
          .where("deleted_at", "is", null)
          .forUpdate()
          .executeTakeFirst();
        if (!row) throw new Refusal<UpdateTypeError>("not_found");
        const changed = changedFields(
          ["name", "durationValue", "durationUnit"],
          {
            name: row.name,
            durationValue: row.duration_value,
            durationUnit: DurationUnit.parse(row.duration_unit),
          },
          input,
        );
        if (Object.keys(changed).length === 0) return { note: null };

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
        if (row.name === input.name || !row.authentik_group_pk)
          return { note: null };
        if (row.authentik_group_origin === "reused")
          return { note: "group_kept" };

        const renamed = await renameTypeGroup(api ?? authentik(), {
          typeId: id,
          pk: row.authentik_group_pk,
          name: input.name,
        });
        if (!renamed.ok)
          throw new Refusal<UpdateTypeError>(
            renamed.error === "name_taken"
              ? "group_clash"
              : renamed.error === "changed"
                ? "group_changed"
                : groupFailure(renamed.error),
          );
        const outcome = renamed.value;
        if (outcome.kind === "unchanged") return { note: null };
        if (outcome.kind === "recreated")
          await trx
            .updateTable("testbed_types")
            .set({ authentik_group_pk: outcome.pk })
            .where("id", "=", id)
            .execute();
        await audit(trx, {
          actorUserId: actorId,
          action:
            outcome.kind === "recreated"
              ? "authentik_group.created"
              : "authentik_group.renamed",
          targetType: "testbed_type",
          targetId: id,
          summary:
            outcome.kind === "recreated"
              ? "Authentik group created for a testbed type"
              : "Authentik group renamed with its testbed type",
          metadata: {
            groupPk:
              outcome.kind === "recreated"
                ? outcome.pk
                : row.authentik_group_pk,
          },
        });
        return { note: null };
      }),
    );
  } catch (e) {
    const mapped = mapConstraintError(e);
    if (!mapped.ok && mapped.error === "duplicate_name")
      return err("duplicate_name");
    throw e;
  }
}

export type DeleteTestbedTypeError =
  | { readonly kind: "blocked"; readonly blockers: readonly Blocker[] }
  | { readonly kind: "not_found" }
  | { readonly kind: "unavailable" };

// "group_left": the group stays in Authentik (AC-10).
export type DeleteTypeOutcome = { readonly note: "group_left" | null };

// Feature 7 (spec 0002 AC-4, AC-14), spec 0026 AC-9, AC-10. Lock, check the
// blockers again, then soft delete, so a testbed added meanwhile cannot slip
// in. The name is free for reuse afterwards (unique among live rows only).
// The group the app made is deleted after that, in the same transaction, so
// an Authentik failure keeps the type.
export async function deleteTestbedType(
  conn: Kysely<DB>,
  id: string,
  actorId: string,
  api?: CoreApi,
): Promise<Result<DeleteTypeOutcome, DeleteTestbedTypeError>> {
  return refusable<DeleteTypeOutcome, DeleteTestbedTypeError>(() =>
    conn.transaction().execute(async (trx) => {
      if (!(await lockForDelete(trx, "testbed_types", id)))
        throw new Refusal<DeleteTestbedTypeError>({ kind: "not_found" });
      const blockers = await testbedTypeBlockers(trx, id);
      if (blockers.length > 0)
        throw new Refusal<DeleteTestbedTypeError>({
          kind: "blocked",
          blockers,
        });

      const row = await trx
        .selectFrom("testbed_types")
        .select(["authentik_group_pk", "authentik_group_origin"])
        .where("id", "=", id)
        .executeTakeFirst();
      await trx
        .updateTable("testbed_types")
        .set({ deleted_at: sql<Date>`now()` })
        .where("id", "=", id)
        .execute();

      const groupPk = row?.authentik_group_pk;
      const made = groupPk && row.authentik_group_origin === "created";
      const group = made
        ? await deleteTypeGroup(api ?? authentik(), { typeId: id, pk: groupPk })
        : null;
      if (group && !group.ok)
        throw new Refusal<DeleteTestbedTypeError>({ kind: "unavailable" });
      const outcome = group?.ok ? group.value : null;

      await audit(trx, {
        actorUserId: actorId,
        action: "testbed_type.deleted",
        targetType: "testbed_type",
        targetId: id,
        summary: "Testbed type deleted",
        ...(outcome?.kind === "left"
          ? { metadata: { groupLeft: true, reason: outcome.reason } }
          : {}),
      });
      if (groupPk && outcome?.kind === "deleted")
        await audit(trx, {
          actorUserId: actorId,
          action: "authentik_group.deleted",
          targetType: "testbed_type",
          targetId: id,
          summary: "Authentik group deleted with its testbed type",
          metadata: { groupPk, memberCount: outcome.memberCount },
        });
      return { note: outcome?.kind === "left" ? "group_left" : null };
    }),
  );
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
