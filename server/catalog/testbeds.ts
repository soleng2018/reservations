import "server-only";
import { sql, type Kysely } from "kysely";
import type { ClientLogin } from "@/lib/booking-email";
import type { TestbedClientInput, TestbedInput } from "@/lib/catalog-input";
import { TestbedClientKind } from "@/lib/db-enums";
import type { Blocker } from "@/lib/delete-flow";
import { err, ok, type Result } from "@/lib/result";
import { slugCandidate, slugify } from "@/lib/slug";
import {
  testbedEditChange,
  type TestbedEditDefaults,
  type TestbedValues,
} from "@/lib/testbeds";
import { audit } from "@/server/audit";
import type { CoreApi } from "@/server/authentik/client";
import {
  createPodGroup,
  deletePodGroup,
  findPodGroupByName,
  podGroupName,
} from "@/server/authentik/groups";
import { mapConstraintError } from "@/server/db/constraint-errors";
import { lockForDelete, testbedBlockers } from "@/server/db/delete-blockers";
import type { DB } from "@/server/db/types";

// The testbed catalog (spec 0004 AC-2, spec 0007). This is the only module
// that names a client's OS password column (tests/os-password-scan.test.ts):
// those logins are plain text by design and leave the server only through
// getTestbedForEdit, to an admin, and clientLoginsForBooking, into the
// learner's booking email.

// The row first group saga (spec 0004 AC-2): insert the testbed with no
// group, create `pod-<slug>` stamped with the row id, then store its pk. A
// testbed is bookable only once the pk is stored. A failed group step undoes
// the row (and a group this attempt created); what the undo cannot finish,
// sweepTestbedCreates finishes after 10 minutes.

export type CreateTestbedError =
  "duplicate_name" | "type_not_found" | "idp_not_found" | "group_failed";

export type AdminTestbedRow = {
  readonly id: string;
  readonly name: string;
  readonly typeName: string;
  readonly idpName: string | null;
  readonly clientCount: number;
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

  // Spec 0007 AC-2: a row an admin soft deleted meanwhile never gets its pk,
  // so it stays unbookable and its group goes with the undo.
  const stored = await conn.transaction().execute(async (trx) => {
    const row = await trx
      .updateTable("testbeds")
      .set({ authentik_group_pk: group.value.pk })
      .where("id", "=", id)
      .where("authentik_group_pk", "is", null)
      .where("deleted_at", "is", null)
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
  if (stored) return ok({ id, slug });
  // Deleted meanwhile, or the sweeper already undid it (then this finds no
  // row and does nothing).
  await undoQuietly(api, conn, id);
  return err("group_failed");
}

// When set, the IDP must be a live `IDP` key, held FOR SHARE until commit so
// spec 0006's delete and type change wait for this save (AC-2).
async function idpIsLive(
  trx: Kysely<DB>,
  idpApiKeyId: string | null,
): Promise<boolean> {
  if (idpApiKeyId === null) return true;
  const key = await trx
    .selectFrom("api_keys")
    .select("id")
    .where("id", "=", idpApiKeyId)
    .where("type", "=", "IDP")
    .where("deleted_at", "is", null)
    .forShare()
    .executeTakeFirst();
  return key !== undefined;
}

async function typeIsLive(
  trx: Kysely<DB>,
  testbedTypeId: string,
): Promise<boolean> {
  const type = await trx
    .selectFrom("testbed_types")
    .select("id")
    .where("id", "=", testbedTypeId)
    .where("deleted_at", "is", null)
    .forShare()
    .executeTakeFirst();
  return type !== undefined;
}

async function insertClients(
  trx: Kysely<DB>,
  testbedId: string,
  clients: readonly TestbedClientInput[],
): Promise<void> {
  if (clients.length === 0) return;
  await trx
    .insertInto("testbed_clients")
    .values(
      clients.map((c, position) => ({
        testbed_id: testbedId,
        kind: c.kind,
        name: c.name,
        url: c.url,
        os_username: c.osUsername,
        os_password: c.osPassword,
        position,
      })),
    )
    .execute();
}

// One transaction: the type and IDP must be live; the slug takes the first
// free `-2`, `-3` suffix. ON CONFLICT DO NOTHING covers both unique indexes,
// so a miss is told apart by looking for a live testbed of the same name.
async function insertTestbedRow(
  conn: Kysely<DB>,
  input: TestbedInput,
): Promise<
  Result<
    { readonly id: string; readonly slug: string },
    "duplicate_name" | "type_not_found" | "idp_not_found"
  >
> {
  return conn.transaction().execute(async (trx) => {
    if (!(await typeIsLive(trx, input.testbedTypeId)))
      return err("type_not_found");
    if (!(await idpIsLive(trx, input.idpApiKeyId))) return err("idp_not_found");

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
          idp_api_key_id: input.idpApiKeyId,
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
    await insertClients(trx, created.value.id, input.clients);
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

// AC-1. Live testbeds by name, with their type, IDP name, and client count.
// No client details: the list never carries an OS login.
export async function listTestbedsForAdmin(
  conn: Kysely<DB>,
): Promise<readonly AdminTestbedRow[]> {
  const rows = await conn
    .selectFrom("testbeds as t")
    .innerJoin("testbed_types as ty", "ty.id", "t.testbed_type_id")
    .leftJoin("api_keys as k", "k.id", "t.idp_api_key_id")
    .select((eb) => [
      "t.id",
      "t.name",
      "ty.name as typeName",
      "k.name as idpName",
      "t.authentik_group_pk",
      eb
        .selectFrom("testbed_clients as c")
        .select(sql<number>`count(*)::int`.as("n"))
        .whereRef("c.testbed_id", "=", "t.id")
        .as("clientCount"),
    ])
    .where("t.deleted_at", "is", null)
    .orderBy(sql`lower(t.name)`)
    .execute();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    typeName: r.typeName,
    idpName: r.idpName,
    clientCount: r.clientCount ?? 0,
    groupReady: r.authentik_group_pk !== null,
  }));
}

async function clientsOf(
  conn: Kysely<DB>,
  testbedId: string,
): Promise<readonly TestbedClientInput[]> {
  const rows = await conn
    .selectFrom("testbed_clients")
    .select(["kind", "name", "url", "os_username", "os_password"])
    .where("testbed_id", "=", testbedId)
    .orderBy("position")
    .execute();
  return rows.map((c) => ({
    kind: TestbedClientKind.parse(c.kind),
    name: c.name,
    url: c.url,
    osUsername: c.os_username,
    osPassword: c.os_password,
  }));
}

// Spec 0007: the OS logins of a booking's testbed, for the worker's booking
// email only. Clients with no username have nothing to show.
export async function clientLoginsForBooking(
  conn: Kysely<DB>,
  bookingId: string,
): Promise<readonly ClientLogin[]> {
  const rows = await conn
    .selectFrom("testbed_clients as c")
    .innerJoin("bookings as b", "b.testbed_id", "c.testbed_id")
    .select(["c.name", "c.url", "c.os_username", "c.os_password"])
    .where("b.id", "=", bookingId)
    .where("c.os_username", "is not", null)
    .orderBy("c.position")
    .execute();
  return rows.flatMap((c) =>
    c.os_username === null
      ? []
      : [
          {
            name: c.name,
            url: c.url,
            username: c.os_username,
            password: c.os_password,
          },
        ],
  );
}

// AC-3. Everything the edit dialog shows, OS logins included. Used only by
// loadTestbedForEdit.
export async function getTestbedForEdit(
  conn: Kysely<DB>,
  id: string,
): Promise<Result<TestbedEditDefaults, "not_found">> {
  const row = await conn
    .selectFrom("testbeds")
    .select([
      "name",
      "slug",
      "testbed_type_id",
      "idp_api_key_id",
      "portal_url",
      "lms_url",
    ])
    .where("id", "=", id)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!row) return err("not_found");
  return ok({
    name: row.name,
    slug: row.slug,
    groupName: podGroupName(row.slug),
    testbedTypeId: row.testbed_type_id,
    idpApiKeyId: row.idp_api_key_id,
    portalUrl: row.portal_url,
    lmsUrl: row.lms_url,
    clients: await clientsOf(conn, id),
  });
}

export type UpdateTestbedError =
  | "duplicate_name"
  | "not_found"
  | "not_ready"
  | "type_not_found"
  | "idp_not_found";

// AC-3, AC-4, AC-5 in one transaction. The testbed is locked FOR UPDATE, so
// a booking (FOR SHARE) and a delete wait. The slug and group never change.
// Clients are replaced as a set, delete first, so the position index never
// trips. A save that changes nothing writes nothing. A duplicate name
// aborts the transaction, so it is mapped outside it.
export async function updateTestbed(
  conn: Kysely<DB>,
  id: string,
  input: TestbedInput,
  actorId: string,
): Promise<Result<void, UpdateTestbedError>> {
  try {
    return await conn.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom("testbeds")
        .select([
          "name",
          "testbed_type_id",
          "idp_api_key_id",
          "portal_url",
          "lms_url",
          "authentik_group_pk",
        ])
        .where("id", "=", id)
        .where("deleted_at", "is", null)
        .forUpdate()
        .executeTakeFirst();
      if (!row) return err("not_found");
      if (row.authentik_group_pk === null) return err("not_ready");
      if (!(await typeIsLive(trx, input.testbedTypeId)))
        return err("type_not_found");
      if (!(await idpIsLive(trx, input.idpApiKeyId)))
        return err("idp_not_found");

      const before: TestbedValues = {
        name: row.name,
        testbedTypeId: row.testbed_type_id,
        idpApiKeyId: row.idp_api_key_id,
        portalUrl: row.portal_url,
        lmsUrl: row.lms_url,
        clients: await clientsOf(trx, id),
      };
      const change = testbedEditChange(before, input);
      if (change === null) return ok(undefined);

      await trx
        .updateTable("testbeds")
        .set({
          name: input.name,
          testbed_type_id: input.testbedTypeId,
          idp_api_key_id: input.idpApiKeyId,
          portal_url: input.portalUrl,
          lms_url: input.lmsUrl,
        })
        .where("id", "=", id)
        .execute();
      if (change.clientsChanged) {
        await trx
          .deleteFrom("testbed_clients")
          .where("testbed_id", "=", id)
          .execute();
        await insertClients(trx, id, input.clients);
      }
      await audit(trx, {
        actorUserId: actorId,
        action: "testbed.updated",
        targetType: "testbed",
        targetId: id,
        summary: "Testbed updated",
        metadata: change.metadata,
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

export type DeleteTestbedError =
  | { readonly kind: "blocked"; readonly blockers: readonly Blocker[] }
  | { readonly kind: "not_found" };

// AC-6 (spec 0002 AC-4, AC-14). Lock, check the bookings again, then soft
// delete, so a booking made meanwhile cannot slip in. The name is free for
// reuse afterwards; the slug is not. The worker tears down the group (AC-7).
export async function deleteTestbed(
  conn: Kysely<DB>,
  id: string,
  actorId: string,
): Promise<Result<void, DeleteTestbedError>> {
  return conn.transaction().execute(async (trx) => {
    if (!(await lockForDelete(trx, "testbeds", id)))
      return err({ kind: "not_found" });
    const blockers = await testbedBlockers(trx, id);
    if (blockers.length > 0) return err({ kind: "blocked", blockers });

    const row = await trx
      .updateTable("testbeds")
      .set({ deleted_at: sql<Date>`now()` })
      .where("id", "=", id)
      .returning(["slug", "authentik_group_pk"])
      .executeTakeFirstOrThrow();
    await audit(trx, {
      actorUserId: actorId,
      action: "testbed.deleted",
      targetType: "testbed",
      targetId: id,
      summary: "Testbed deleted",
      metadata: { slug: row.slug, groupPk: row.authentik_group_pk },
    });
    return ok(undefined);
  });
}
