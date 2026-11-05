import "server-only";
import type { Kysely } from "kysely";
import { err, ok, type Result } from "@/lib/result";
import { audit } from "@/server/audit";
import type { CoreApi } from "@/server/authentik/client";
import {
  ensureTypeGroup,
  lookupTypeGroup,
} from "@/server/authentik/type-groups";
import { Refusal, refusable } from "@/server/db/refusal";
import { lockTypeEdit } from "@/server/db/type-edit-lock";
import type { DB } from "@/server/db/types";

// Spec 0026 AC-14, AC-15: give every live type that has no group its group,
// under its current name. A dry run reads only. Each type is its own
// transaction holding the type's advisory lock (spec 0026 AC-19) and the row lock, and the pk is checked again under it, so
// an admin edit made at the same moment is never overwritten. A skipped type
// (an unsafe same name group, a group another type holds) is reported and the
// rest go on; an unreachable Authentik stops the run.

export type BackfillLine = {
  readonly typeId: string;
  readonly name: string;
  readonly result: "created" | "linked" | "skipped";
  readonly reason?: "unsafe" | "group_in_use" | "name_invalid" | "already_done";
};

export type BackfillReport = {
  readonly lines: readonly BackfillLine[];
  // Set when Authentik could not be reached and the run stopped there.
  readonly stopped: boolean;
};

const unlinked = (conn: Kysely<DB>) =>
  conn
    .selectFrom("testbed_types")
    .select(["id", "name"])
    .where("deleted_at", "is", null)
    .where("authentik_group_pk", "is", null)
    .orderBy("name")
    .execute();

const holder = (conn: Kysely<DB>, pk: string) =>
  conn
    .selectFrom("testbed_types")
    .select("id")
    .where("authentik_group_pk", "=", pk)
    .where("deleted_at", "is", null)
    .executeTakeFirst();

async function dryRun(conn: Kysely<DB>, api: CoreApi): Promise<BackfillReport> {
  const lines: BackfillLine[] = [];
  for (const t of await unlinked(conn)) {
    const found = await lookupTypeGroup(api, t.name);
    if (!found.ok && found.error === "unavailable")
      return { lines, stopped: true };
    const base = { typeId: t.id, name: t.name };
    if (!found.ok) lines.push({ ...base, result: "skipped", reason: "unsafe" });
    else if (found.value === null) lines.push({ ...base, result: "created" });
    else
      lines.push(
        (await holder(conn, found.value))
          ? { ...base, result: "skipped", reason: "group_in_use" }
          : { ...base, result: "linked" },
      );
  }
  return { lines, stopped: false };
}

type Stop = "unavailable";

async function applyOne(
  conn: Kysely<DB>,
  api: CoreApi,
  t: { readonly id: string; readonly name: string },
): Promise<Result<BackfillLine, Stop>> {
  const base = { typeId: t.id, name: t.name };
  const done = await refusable<BackfillLine, "unavailable" | BackfillLine>(() =>
    conn.transaction().execute(async (trx) => {
      await lockTypeEdit(trx, t.id);
      const row = await trx
        .selectFrom("testbed_types")
        .select(["name", "authentik_group_pk"])
        .where("id", "=", t.id)
        .where("deleted_at", "is", null)
        .forUpdate()
        .executeTakeFirst();
      // Gone, renamed, or linked since the list: leave it for the next run.
      if (!row || row.authentik_group_pk)
        throw new Refusal<BackfillLine>({
          ...base,
          result: "skipped",
          reason: "already_done",
        });
      const group = await ensureTypeGroup(api, {
        typeId: t.id,
        name: row.name,
      });
      if (!group.ok) {
        if (group.error === "unavailable") throw new Refusal("unavailable");
        throw new Refusal<BackfillLine>({
          ...base,
          result: "skipped",
          reason: group.error === "unsafe" ? "unsafe" : "name_invalid",
        });
      }
      if (
        group.value.outcome === "linked" &&
        (await holder(trx, group.value.pk))
      )
        throw new Refusal<BackfillLine>({
          ...base,
          result: "skipped",
          reason: "group_in_use",
        });
      await trx
        .updateTable("testbed_types")
        .set({
          authentik_group_pk: group.value.pk,
          authentik_group_origin: group.value.origin,
        })
        .where("id", "=", t.id)
        .execute();
      await audit(trx, {
        actorUserId: null,
        action:
          group.value.outcome === "created"
            ? "authentik_group.created"
            : "authentik_group.linked",
        targetType: "testbed_type",
        targetId: t.id,
        summary: "Authentik group set up for a testbed type by the backfill",
        metadata: { groupPk: group.value.pk, backfill: true },
      });
      return {
        ...base,
        result: group.value.outcome === "created" ? "created" : "linked",
      } satisfies BackfillLine;
    }),
  );
  if (done.ok) return ok(done.value);
  return done.error === "unavailable" ? err("unavailable") : ok(done.error);
}

export async function backfillTypeGroups(
  conn: Kysely<DB>,
  api: CoreApi,
  apply: boolean,
): Promise<BackfillReport> {
  if (!apply) return dryRun(conn, api);
  const lines: BackfillLine[] = [];
  for (const t of await unlinked(conn)) {
    const one = await applyOne(conn, api, t);
    if (!one.ok) return { lines, stopped: true };
    lines.push(one.value);
  }
  return { lines, stopped: false };
}
