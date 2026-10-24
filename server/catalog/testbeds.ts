import "server-only";
import { sql, type Kysely } from "kysely";
import type { ClientLogin } from "@/lib/booking-email";
import type {
  TestbedClientInput,
  TestbedInput,
  TestbedUpdateInput,
} from "@/lib/catalog-input";
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
import { findTestbedGroup } from "@/server/authentik/groups";
import { mapConstraintError } from "@/server/db/constraint-errors";
import { lockForDelete, testbedBlockers } from "@/server/db/delete-blockers";
import type { DB } from "@/server/db/types";

// The testbed catalog (spec 0004 AC-2, spec 0007, spec 0017). This is the
// only module that names a client's OS password column
// (tests/os-password-scan.test.ts): those logins are plain text by design and
// leave the server only through getTestbedForEdit, to an admin, and
// clientLoginsForBooking, into the learner's booking email.

// Spec 0017 AC-3, spec 0018: the testbed's group name is the name of an
// Authentik group the owner already made and marked; its name is the free text
// learners see. Create checks for duplicates, then looks the group up, then
// inserts one row with the group's pk, so a testbed is bookable at once and
// nothing is half made. The app never creates or deletes a group.

export type CreateTestbedError =
  | "duplicate_name"
  | "duplicate_group_name"
  | "duplicate_domain"
  | "type_not_found"
  | "idp_not_found"
  | "group_not_found"
  | "group_not_testbed_group"
  | "group_in_use"
  | "authentik_unavailable";

export type AdminTestbedRow = {
  readonly id: string;
  readonly name: string;
  readonly groupName: string;
  readonly typeName: string;
  readonly domain: string;
  readonly idpName: string | null;
  readonly clientCount: number;
};

const MAX_SLUG_ATTEMPTS = 100;

// Live testbeds only: a soft deleted one frees its name, group name, domain,
// and group. `exceptId` leaves the row being edited out.
const liveByName = (conn: Kysely<DB>, name: string, exceptId?: string) =>
  conn
    .selectFrom("testbeds")
    .select("id")
    .where(sql<string>`lower(name)`, "=", name.toLowerCase())
    .where("deleted_at", "is", null)
    .$if(exceptId !== undefined, (qb) => qb.where("id", "<>", exceptId ?? ""))
    .executeTakeFirst();

const liveByGroupName = (conn: Kysely<DB>, groupName: string) =>
  conn
    .selectFrom("testbeds")
    .select("id")
    .where(sql<string>`lower(group_name)`, "=", groupName.toLowerCase())
    .where("deleted_at", "is", null)
    .executeTakeFirst();

const liveByDomain = (conn: Kysely<DB>, domain: string) =>
  conn
    .selectFrom("testbeds")
    .select("id")
    .where("domain", "=", domain)
    .where("deleted_at", "is", null)
    .executeTakeFirst();

const liveByGroup = (conn: Kysely<DB>, groupPk: string) =>
  conn
    .selectFrom("testbeds")
    .select("id")
    .where("authentik_group_pk", "=", groupPk)
    .where("deleted_at", "is", null)
    .executeTakeFirst();

// Spec 0018 AC-3: the name, then the group name, then the domain, all before
// Authentik is called, so a taken one shows its message even when Authentik is
// down.
async function duplicateOf(
  conn: Kysely<DB>,
  input: Pick<TestbedInput, "name" | "groupName" | "domain">,
): Promise<
  "duplicate_name" | "duplicate_group_name" | "duplicate_domain" | undefined
> {
  if (await liveByName(conn, input.name)) return "duplicate_name";
  if (await liveByGroupName(conn, input.groupName))
    return "duplicate_group_name";
  if (await liveByDomain(conn, input.domain)) return "duplicate_domain";
  return undefined;
}

export async function createTestbed(
  api: CoreApi,
  conn: Kysely<DB>,
  input: TestbedInput,
  actorId: string,
): Promise<
  Result<{ readonly id: string; readonly slug: string }, CreateTestbedError>
> {
  const duplicate = await duplicateOf(conn, input);
  if (duplicate) return err(duplicate);

  // The Authentik read happens before the transaction opens.
  const group = await findTestbedGroup(api, input.groupName);
  if (!group.ok) {
    switch (group.error) {
      case "not_found":
        return err("group_not_found");
      case "not_testbed_group":
        return err("group_not_testbed_group");
      case "unavailable":
        return err("authentik_unavailable");
      default: {
        const never: never = group.error;
        return never;
      }
    }
  }
  if (await liveByGroup(conn, group.value.pk)) return err("group_in_use");

  return insertTestbed(
    conn,
    input,
    { pk: group.value.pk, name: group.value.name },
    actorId,
  );
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
// free `-2`, `-3` suffix, built from the group name. ON CONFLICT DO NOTHING
// covers every unique index, so a miss is told apart in order: a live testbed
// of the same name, of the same group name, of the same domain, or on the same
// group (two admins saving at once get the same messages as the precheck),
// else it was a slug clash. The stored group name is the found group's.
async function insertTestbed(
  conn: Kysely<DB>,
  input: TestbedInput,
  group: { readonly pk: string; readonly name: string },
  actorId: string,
): Promise<
  Result<
    { readonly id: string; readonly slug: string },
    | "duplicate_name"
    | "duplicate_group_name"
    | "duplicate_domain"
    | "group_in_use"
    | "type_not_found"
    | "idp_not_found"
  >
> {
  return conn.transaction().execute(async (trx) => {
    if (!(await typeIsLive(trx, input.testbedTypeId)))
      return err("type_not_found");
    if (!(await idpIsLive(trx, input.idpApiKeyId))) return err("idp_not_found");

    const base = slugify(input.groupName);
    const attempt = async (
      n: number,
    ): Promise<
      Result<
        { readonly id: string; readonly slug: string },
        | "duplicate_name"
        | "duplicate_group_name"
        | "duplicate_domain"
        | "group_in_use"
      >
    > => {
      if (n > MAX_SLUG_ATTEMPTS)
        throw new Error(`no free slug for ${base} after ${MAX_SLUG_ATTEMPTS}`);
      const slug = slugCandidate(base, n);
      const row = await trx
        .insertInto("testbeds")
        .values({
          name: input.name,
          group_name: group.name,
          slug,
          domain: input.domain,
          authentik_group_pk: group.pk,
          testbed_type_id: input.testbedTypeId,
          idp_api_key_id: input.idpApiKeyId,
          portal_url: input.portalUrl,
          lms_url: input.lmsUrl,
        })
        .onConflict((oc) => oc.doNothing())
        .returning("id")
        .executeTakeFirst();
      if (row) return ok({ id: row.id, slug });
      const duplicate = await duplicateOf(trx, input);
      if (duplicate) return err(duplicate);
      if (await liveByGroup(trx, group.pk)) return err("group_in_use");
      return attempt(n + 1);
    };
    const created = await attempt(1);
    if (!created.ok) return created;
    await insertClients(trx, created.value.id, input.clients);
    await audit(trx, {
      actorUserId: actorId,
      action: "testbed.created",
      targetType: "testbed",
      targetId: created.value.id,
      summary: "Testbed created",
      metadata: {
        slug: created.value.slug,
        name: input.name,
        groupName: group.name,
        domain: input.domain,
        groupPk: group.pk,
        clients: input.clients.length,
      },
    });
    return created;
  });
}

// Spec 0018 AC-8. Live testbeds by name, with their group name, type, domain,
// IDP name, and client count. No client details: the list never carries an OS login.
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
      "t.group_name",
      "ty.name as typeName",
      "t.domain",
      "k.name as idpName",
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
    groupName: r.group_name,
    typeName: r.typeName,
    // A live row always has a domain (testbeds_domain_live_check).
    domain: r.domain ?? "",
    idpName: r.idpName,
    clientCount: r.clientCount ?? 0,
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
      "group_name",
      "slug",
      "domain",
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
    groupName: row.group_name,
    slug: row.slug,
    domain: row.domain ?? "",
    testbedTypeId: row.testbed_type_id,
    idpApiKeyId: row.idp_api_key_id,
    portalUrl: row.portal_url,
    lmsUrl: row.lms_url,
    clients: await clientsOf(conn, id),
  });
}

export type UpdateTestbedError =
  | "not_found"
  | "type_not_found"
  | "idp_not_found"
  | "domain_locked"
  | "duplicate_name"
  | "duplicate_domain";

// Spec 0018 AC-4, spec 0017 AC-6 and spec 0007 AC-3, AC-4, AC-5 in one
// transaction. The testbed is locked FOR UPDATE, so a booking (FOR SHARE) and a
// delete wait. The slug and group name never change. The Name does, with no
// booking lock and no Authentik call. A domain change is refused while an
// Upcoming or Current reservation exists. Clients are replaced as a set,
// delete first, so the position index never trips. A save that changes nothing
// writes nothing. A taken name or domain aborts the transaction on a race, so
// that is mapped outside it.
export async function updateTestbed(
  conn: Kysely<DB>,
  id: string,
  input: TestbedUpdateInput,
  actorId: string,
): Promise<Result<{ readonly name: string }, UpdateTestbedError>> {
  try {
    return await conn.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom("testbeds")
        .select([
          "name",
          "domain",
          "testbed_type_id",
          "idp_api_key_id",
          "portal_url",
          "lms_url",
        ])
        .where("id", "=", id)
        .where("deleted_at", "is", null)
        .forUpdate()
        .executeTakeFirst();
      if (!row) return err("not_found");
      if (!(await typeIsLive(trx, input.testbedTypeId)))
        return err("type_not_found");
      if (!(await idpIsLive(trx, input.idpApiKeyId)))
        return err("idp_not_found");

      const before: TestbedValues = {
        name: row.name,
        domain: row.domain ?? "",
        testbedTypeId: row.testbed_type_id,
        idpApiKeyId: row.idp_api_key_id,
        portalUrl: row.portal_url,
        lmsUrl: row.lms_url,
        clients: await clientsOf(trx, id),
      };
      const change = testbedEditChange(before, input);
      if (change === null) return ok({ name: row.name });

      if (
        input.domain !== before.domain &&
        (await testbedBlockers(trx, id)).length > 0
      )
        return err("domain_locked");
      if (input.name !== before.name && (await liveByName(trx, input.name, id)))
        return err("duplicate_name");
      if (input.domain !== before.domain) {
        const taken = await liveByDomain(trx, input.domain);
        if (taken && taken.id !== id) return err("duplicate_domain");
      }

      await trx
        .updateTable("testbeds")
        .set({
          name: input.name,
          domain: input.domain,
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
      return ok({ name: input.name });
    });
  } catch (e) {
    const mapped = mapConstraintError(e);
    if (!mapped.ok && mapped.error === "duplicate_name")
      return err("duplicate_name");
    if (!mapped.ok && mapped.error === "duplicate_domain")
      return err("duplicate_domain");
    throw e;
  }
}

export type DeleteTestbedError =
  | { readonly kind: "blocked"; readonly blockers: readonly Blocker[] }
  | { readonly kind: "not_found" };

// AC-6 (spec 0002 AC-4, AC-14). Lock, check the bookings again, then soft
// delete, so a booking made meanwhile cannot slip in. The name, domain, and
// group are free for reuse afterwards; the slug is not. No group is touched
// here: the worker releases it (spec 0017 AC-9).
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
