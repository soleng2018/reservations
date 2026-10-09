import "server-only";
import { sql, type Kysely } from "kysely";
import type { TestbedInput } from "@/lib/catalog-input";
import { err, ok, type Result } from "@/lib/result";
import { slugCandidate, slugify } from "@/lib/slug";
import { audit } from "@/server/audit";
import type { CoreApi } from "@/server/authentik/client";
import {
  createPodGroup,
  deletePodGroup,
  findPodGroupByName,
  podGroupName,
} from "@/server/authentik/groups";
import type { DB } from "@/server/db/types";

// The row first group saga (spec 0004 AC-2): insert the testbed with no
// group, create `pod-<slug>` stamped with the row id, then store its pk. A
// testbed is bookable only once the pk is stored. A failed group step undoes
// the row (and a group this attempt created); what the undo cannot finish,
// sweepTestbedCreates finishes after 10 minutes.

export type CreateTestbedError =
  "duplicate_name" | "type_not_found" | "group_failed";

export type TestbedListRow = {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly typeName: string;
  readonly groupReady: boolean;
};

const MAX_SLUG_ATTEMPTS = 100;

export async function createTestbed(
  api: CoreApi,
  conn: Kysely<DB>,
  input: TestbedInput,
  actorId: string,
): Promise<
  Result<{ readonly id: string; readonly slug: string }, CreateTestbedError>
> {
  const inserted = await insertTestbedRow(conn, input);
  if (!inserted.ok) return inserted;
  const { id, slug } = inserted.value;

  const group = await createPodGroup(api, podGroupName(slug), id);
  if (!group.ok) {
    console.error(`testbed create: group step failed: ${group.error}`);
    await undoQuietly(api, conn, id);
    return err("group_failed");
  }

  const stored = await conn.transaction().execute(async (trx) => {
    const row = await trx
      .updateTable("testbeds")
      .set({ authentik_group_pk: group.value.pk })
      .where("id", "=", id)
      .where("authentik_group_pk", "is", null)
      .returning("id")
      .executeTakeFirst();
    if (!row) return false;
    await audit(trx, {
      actorUserId: actorId,
      action: "testbed.created",
      targetType: "testbed",
      targetId: id,
      summary: "Testbed created",
      metadata: { slug, clients: input.clients.length },
    });
    await audit(trx, {
      actorUserId: actorId,
      action: "authentik_group.created",
      targetType: "authentik_group",
      targetId: group.value.pk,
      summary: "Testbed access group created",
      metadata: { testbedId: id, name: group.value.name },
    });
    return true;
  });
  // Only the sweeper removes a row without a pk, so this means it already
  // undid this attempt (group included).
  return stored ? ok({ id, slug }) : err("group_failed");
}

// One transaction: the type must be live; the slug takes the first free
// `-2`, `-3` suffix. ON CONFLICT DO NOTHING covers both unique indexes, so a
// miss is told apart by looking for a live testbed of the same name.
async function insertTestbedRow(
  conn: Kysely<DB>,
  input: TestbedInput,
): Promise<
  Result<
    { readonly id: string; readonly slug: string },
    "duplicate_name" | "type_not_found"
  >
> {
  return conn.transaction().execute(async (trx) => {
    const type = await trx
      .selectFrom("testbed_types")
      .select("id")
      .where("id", "=", input.testbedTypeId)
      .where("deleted_at", "is", null)
      .forShare()
      .executeTakeFirst();
    if (!type) return err("type_not_found");

    const base = slugify(input.name);
    const attempt = async (
      n: number,
    ): Promise<
      Result<{ readonly id: string; readonly slug: string }, "duplicate_name">
    > => {
      if (n > MAX_SLUG_ATTEMPTS)
        throw new Error(`no free slug for ${base} after ${MAX_SLUG_ATTEMPTS}`);
      const slug = slugCandidate(base, n);
      const row = await trx
        .insertInto("testbeds")
        .values({
          name: input.name,
          slug,
          testbed_type_id: input.testbedTypeId,
          portal_url: input.portalUrl,
          lms_url: input.lmsUrl,
        })
        .onConflict((oc) => oc.doNothing())
        .returning("id")
        .executeTakeFirst();
      if (row) return ok({ id: row.id, slug });
      const sameName = await trx
        .selectFrom("testbeds")
        .select("id")
        .where(sql<string>`lower(name)`, "=", input.name.toLowerCase())
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      return sameName ? err("duplicate_name") : attempt(n + 1);
    };
    const created = await attempt(1);
    if (!created.ok) return created;

    if (input.clients.length > 0)
      await trx
        .insertInto("testbed_clients")
        .values(
          input.clients.map((c, position) => ({
            testbed_id: created.value.id,
            kind: c.kind,
            name: c.name,
            url: c.url,
            position,
          })),
        )
        .execute();
    return created;
  });
}

export type UndoError = "unavailable" | "refused";

// Removes a testbed that never had a group pk, after deleting `pod-<slug>`
// only if that group carries this row's id (spec 0004 AC-11). The row is
// locked FOR UPDATE, so a create storing its pk meanwhile waits and then
// keeps its row. True when the row was removed.
export async function undoTestbedCreate(
  api: CoreApi,
  conn: Kysely<DB>,
  testbedId: string,
): Promise<Result<boolean, UndoError>> {
  return conn.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom("testbeds")
      .select(["id", "slug"])
      .where("id", "=", testbedId)
      .where("authentik_group_pk", "is", null)
      .forUpdate()
      .executeTakeFirst();
    if (!row) return ok(false);

    const group = await findPodGroupByName(api, podGroupName(row.slug));
    if (!group.ok) return err("unavailable");
    if (group.value?.testbedId === row.id) {
      const deleted = await deletePodGroup(api, group.value.pk, row.id);
      if (!deleted.ok && deleted.error !== "not_found")
        return err(deleted.error === "unavailable" ? "unavailable" : "refused");
      await audit(trx, {
        actorUserId: null,
        action: "authentik_group.deleted",
        targetType: "authentik_group",
        targetId: group.value.pk,
        summary: "Access group of an unfinished testbed create removed",
        metadata: { testbedId: row.id, name: group.value.name },
      });
    }

    await trx
      .deleteFrom("testbeds")
      .where("id", "=", row.id)
      .where("authentik_group_pk", "is", null)
      .execute();
    return ok(true);
  });
}

async function undoQuietly(
  api: CoreApi,
  conn: Kysely<DB>,
  testbedId: string,
): Promise<void> {
  try {
    const undone = await undoTestbedCreate(api, conn, testbedId);
    if (!undone.ok)
      console.error(
        `testbed create: undo failed (${undone.error}); the sweeper will retry`,
      );
  } catch (e) {
    console.error("testbed create: undo failed; the sweeper will retry", e);
  }
}

// Live testbeds with their type, by name.
export async function listTestbeds(
  conn: Kysely<DB>,
): Promise<readonly TestbedListRow[]> {
  const rows = await conn
    .selectFrom("testbeds as t")
    .innerJoin("testbed_types as ty", "ty.id", "t.testbed_type_id")
    .select([
      "t.id",
      "t.name",
      "t.slug",
      "ty.name as typeName",
      "t.authentik_group_pk",
    ])
    .where("t.deleted_at", "is", null)
    .orderBy(sql`lower(t.name)`)
    .execute();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    typeName: r.typeName,
    groupReady: r.authentik_group_pk !== null,
  }));
}
