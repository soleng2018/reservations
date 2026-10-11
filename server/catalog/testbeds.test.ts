import { sql, type Kysely, type Transaction } from "kysely";
import { afterAll, describe, expect, it } from "vitest";
import type { TestbedInput } from "@/lib/catalog-input";
import type { CoreApi } from "@/server/authentik/client";
import { fakeAuthentik, fakeGroup } from "@/server/authentik/testing";
import { db } from "@/server/db";
import { lockBookableTestbed } from "@/server/db/bookings";
import {
  asConn,
  attempt,
  hasDb,
  inRollback,
  makeTestbed,
  makeType,
  makeUser,
  slot,
} from "@/server/db/testing";
import type { DB } from "@/server/db/types";
import {
  createTestbed,
  deleteTestbed,
  getTestbedForEdit,
  listTestbedsForAdmin,
  undoTestbedCreate,
  updateTestbed,
} from "./testbeds";
import { createTestbedType, listTestbedTypes } from "./testbed-types";

const unique = () => crypto.randomUUID().slice(0, 8);

// A value that must never reach an audit row.
const PASSWORD = `pw ${unique()} `;

async function setup(trx: Kysely<DB>) {
  const admin = await makeUser(trx, { role: "admin", company: null });
  const type = await makeType(trx);
  const name = `Lab ${unique()}`;
  const input: TestbedInput = {
    name,
    testbedTypeId: type.id,
    idpApiKeyId: null,
    portalUrl: "https://portal.example.test",
    lmsUrl: "https://lms.example.test",
    clients: [
      {
        kind: "wired",
        name: "Wired 1",
        url: "https://w1.example.test",
        osUsername: "labuser",
        osPassword: PASSWORD,
      },
      {
        kind: "wireless",
        name: "Air 1",
        url: "https://a1.example.test",
        osUsername: null,
        osPassword: null,
      },
    ],
  };
  const rowsNamed = (n: string) =>
    trx
      .selectFrom("testbeds")
      .select(["id", "slug", "authentik_group_pk"])
      .where(sql<string>`lower(name)`, "=", n.toLowerCase())
      .execute();
  const audits = (targetId: string) =>
    trx
      .selectFrom("audit_events")
      .select("action")
      .where("target_id", "=", targetId)
      .orderBy("action")
      .execute();
  return { admin, type, input, rowsNamed, audits };
}

const makeKey = (
  trx: Kysely<DB>,
  over: { type?: "IDP" | "AI"; deleted_at?: Date; name?: string } = {},
) =>
  trx
    .insertInto("api_keys")
    .values({
      name: over.name ?? `Key ${unique()}`,
      type: over.type ?? "IDP",
      base_url: "https://idp.example.test",
      secret_ciphertext: "v1:test:placeholder",
      deleted_at: over.deleted_at,
    })
    .returning(["id", "name"])
    .executeTakeFirstOrThrow();

const clientRows = (trx: Kysely<DB>, testbedId: string) =>
  trx
    .selectFrom("testbed_clients")
    .select(["id", "kind", "name", "os_username", "os_password", "position"])
    .where("testbed_id", "=", testbedId)
    .orderBy("position")
    .execute();

const updates = (trx: Kysely<DB>, testbedId: string) =>
  trx
    .selectFrom("audit_events")
    .select(["actor_user_id", "target_type", "summary", "metadata"])
    .where("target_id", "=", testbedId)
    .where("action", "=", "testbed.updated")
    .execute();

afterAll(() => (hasDb ? db().destroy() : undefined));

describe.skipIf(!hasDb)("createTestbedType (AC-1)", () => {
  it("creates a type and audits it, refusing a duplicate ignoring case", () =>
    inRollback(async (trx) => {
      const admin = await makeUser(trx, { role: "admin", company: null });
      const name = `Type ${unique()}`;
      const input = { name, durationValue: 2, durationUnit: "hours" } as const;
      const created = await createTestbedType(asConn(trx), input, admin.id);
      if (!created.ok) throw new Error(created.error);
      const audit = await trx
        .selectFrom("audit_events")
        .select(["action", "actor_user_id"])
        .where("target_id", "=", created.value.id)
        .execute();
      expect(audit).toEqual([
        { action: "testbed_type.created", actor_user_id: admin.id },
      ]);
      expect(
        await createTestbedType(
          asConn(trx),
          { ...input, name: name.toUpperCase() },
          admin.id,
        ),
      ).toEqual({ ok: false, error: "duplicate_name" });
    }));

  it("lets a deleted type's name be used again", () =>
    inRollback(async (trx) => {
      const admin = await makeUser(trx, { role: "admin", company: null });
      const name = `Type ${unique()}`;
      await makeType(trx, { name, deleted_at: new Date() });
      const created = await createTestbedType(
        asConn(trx),
        { name, durationValue: 3, durationUnit: "days" },
        admin.id,
      );
      expect(created.ok).toBe(true);
    }));
});

describe.skipIf(!hasDb)("listTestbedTypes (AC-1)", () => {
  it("lists live types by name ignoring case, with their duration", () =>
    inRollback(async (trx) => {
      const tag = unique();
      const b = await makeType(trx, { name: `b ${tag}` });
      const a = await makeType(trx, {
        name: `A ${tag}`,
        duration_value: 5,
        duration_unit: "days",
      });
      await makeType(trx, { name: `c ${tag}`, deleted_at: new Date() });
      const mine = (await listTestbedTypes(trx)).filter((t) =>
        t.name.endsWith(tag),
      );
      expect(mine).toEqual([
        {
          id: a.id,
          name: a.name,
          durationValue: 5,
          durationUnit: "days",
          testbedCount: 0,
        },
        {
          id: b.id,
          name: b.name,
          durationValue: 2,
          durationUnit: "hours",
          testbedCount: 0,
        },
      ]);
    }));
});

// covers: spec 0007 AC-1, Value sourcing (list)
describe.skipIf(!hasDb)("listTestbedsForAdmin (AC-1)", () => {
  it("lists live testbeds by name ignoring case, with type, IDP, and client count", () =>
    inRollback(async (trx) => {
      const tag = unique();
      const type = await makeType(trx, { name: `Type ${tag}` });
      const key = await makeKey(trx);
      const b = await makeTestbed(trx, type.id, {
        name: `b ${tag}`,
        idp_api_key_id: key.id,
      });
      const a = await makeTestbed(trx, type.id, { name: `A ${tag}` });
      await trx
        .insertInto("testbed_clients")
        .values(
          [0, 1, 2].map((position) => ({
            testbed_id: b.id,
            kind: "wired",
            name: `C${position}`,
            url: "https://c.example.test",
            os_username: "u",
            os_password: PASSWORD,
            position,
          })),
        )
        .execute();
      await makeTestbed(trx, type.id, {
        name: `c ${tag}`,
        deleted_at: new Date(),
      });
      const mine = (await listTestbedsForAdmin(trx)).filter((t) =>
        t.name.endsWith(tag),
      );
      expect(mine).toEqual([
        {
          id: a.id,
          name: a.name,
          typeName: type.name,
          idpName: null,
          clientCount: 0,
          groupReady: true,
        },
        {
          id: b.id,
          name: b.name,
          typeName: type.name,
          idpName: key.name,
          clientCount: 3,
          groupReady: true,
        },
      ]);
      // No client details, so no OS login, in the list payload.
      expect(JSON.stringify(mine)).not.toContain(PASSWORD);
    }));

  it("marks a testbed whose group pk is missing as not ready", () =>
    inRollback(async (trx) => {
      const type = await makeType(trx);
      const tb = await makeTestbed(trx, type.id, { authentik_group_pk: null });
      const listed = (await listTestbedsForAdmin(trx)).find(
        (t) => t.id === tb.id,
      );
      expect(listed?.groupReady).toBe(false);
    }));
});

// covers: spec 0004 AC-2, AC-11 (the undo the sweeper shares); spec 0007 AC-2
describe.skipIf(!hasDb)("createTestbed (AC-2)", () => {
  it("inserts the row, creates pod-<slug> stamped with its id, then stores the pk", () =>
    inRollback(async (trx) => {
      const { admin, input, rowsNamed, audits } = await setup(trx);
      const ak = fakeAuthentik([]);
      const r = await createTestbed(ak.api, asConn(trx), input, admin.id);
      if (!r.ok) throw new Error(r.error);

      const group = ak.groups.find((g) => g.name === `pod-${r.value.slug}`);
      expect(group?.attributes).toEqual({ hol_testbed_id: r.value.id });
      expect(await rowsNamed(input.name)).toEqual([
        { id: r.value.id, slug: r.value.slug, authentik_group_pk: group?.pk },
      ]);
      expect(await clientRows(trx, r.value.id)).toMatchObject([
        {
          kind: "wired",
          name: "Wired 1",
          os_username: "labuser",
          os_password: PASSWORD,
          position: 0,
        },
        {
          kind: "wireless",
          name: "Air 1",
          os_username: null,
          os_password: null,
          position: 1,
        },
      ]);
      expect(await audits(r.value.id)).toEqual([{ action: "testbed.created" }]);
      expect(await audits(group?.pk ?? "")).toEqual([
        { action: "authentik_group.created" },
      ]);
      const listed = await listTestbedsForAdmin(trx);
      expect(listed.find((t) => t.id === r.value.id)?.groupReady).toBe(true);
    }));

  it("stores a live IDP key", () =>
    inRollback(async (trx) => {
      const { admin, input } = await setup(trx);
      const key = await makeKey(trx);
      const ak = fakeAuthentik([]);
      const r = await createTestbed(
        ak.api,
        asConn(trx),
        { ...input, idpApiKeyId: key.id },
        admin.id,
      );
      if (!r.ok) throw new Error(r.error);
      const row = await trx
        .selectFrom("testbeds")
        .select("idp_api_key_id")
        .where("id", "=", r.value.id)
        .executeTakeFirstOrThrow();
      expect(row.idp_api_key_id).toBe(key.id);
    }));

  // covers: the IDP race (a key deleted, or changed to AI, before the save)
  it.each([
    ["soft deleted", { deleted_at: new Date() }],
    ["an AI key", { type: "AI" as const }],
  ])("refuses an IDP that is %s and writes nothing", (_, over) =>
    inRollback(async (trx) => {
      const { admin, input, rowsNamed } = await setup(trx);
      const key = await makeKey(trx, over);
      const ak = fakeAuthentik([]);
      expect(
        await createTestbed(
          ak.api,
          asConn(trx),
          { ...input, idpApiKeyId: key.id },
          admin.id,
        ),
      ).toEqual({ ok: false, error: "idp_not_found" });
      expect(await rowsNamed(input.name)).toEqual([]);
      expect(ak.writes).toEqual([]);
    }),
  );

  it("suffixes a slug already taken, and refuses a duplicate name", () =>
    inRollback(async (trx) => {
      const { admin, input } = await setup(trx);
      const ak = fakeAuthentik([]);
      const first = await createTestbed(ak.api, asConn(trx), input, admin.id);
      if (!first.ok) throw new Error(first.error);
      const second = await createTestbed(
        ak.api,
        asConn(trx),
        { ...input, name: input.name.replace(" ", "-") },
        admin.id,
      );
      expect(second).toMatchObject({
        ok: true,
        value: { slug: `${first.value.slug}-2` },
      });
      const writes = ak.writes.length;
      expect(
        await createTestbed(
          ak.api,
          asConn(trx),
          { ...input, name: input.name.toUpperCase() },
          admin.id,
        ),
      ).toEqual({ ok: false, error: "duplicate_name" });
      expect(ak.writes).toHaveLength(writes);
    }));

  it("refuses a missing or deleted type", () =>
    inRollback(async (trx) => {
      const { admin, input, type } = await setup(trx);
      await trx
        .updateTable("testbed_types")
        .set({ deleted_at: new Date() })
        .where("id", "=", type.id)
        .execute();
      const ak = fakeAuthentik([]);
      expect(await createTestbed(ak.api, asConn(trx), input, admin.id)).toEqual(
        { ok: false, error: "type_not_found" },
      );
      expect(ak.writes).toEqual([]);
    }));

  it("leaves no row when the group create fails", () =>
    inRollback(async (trx) => {
      const { admin, input, rowsNamed } = await setup(trx);
      const ak = fakeAuthentik([], {
        fail: (m, p) => m === "POST" && p === "/core/groups/",
      });
      expect(await createTestbed(ak.api, asConn(trx), input, admin.id)).toEqual(
        { ok: false, error: "group_failed" },
      );
      expect(await rowsNamed(input.name)).toEqual([]);
    }));

  it("leaves the row for the sweeper when Authentik is down", () =>
    inRollback(async (trx) => {
      const { admin, input, rowsNamed } = await setup(trx);
      const ak = fakeAuthentik([], { down: true });
      expect(await createTestbed(ak.api, asConn(trx), input, admin.id)).toEqual(
        { ok: false, error: "group_failed" },
      );
      expect(await rowsNamed(input.name)).toMatchObject([
        { authentik_group_pk: null },
      ]);
    }));

  it("never adopts an existing pod-<slug> group, and leaves it alone", () =>
    inRollback(async (trx) => {
      const { admin, input, rowsNamed } = await setup(trx);
      const slug = input.name.toLowerCase().replace(" ", "-");
      const foreign = fakeGroup("foreign", `pod-${slug}`, {
        hol_testbed_id: crypto.randomUUID(),
      });
      const ak = fakeAuthentik([], { groups: [foreign] });
      expect(await createTestbed(ak.api, asConn(trx), input, admin.id)).toEqual(
        { ok: false, error: "group_failed" },
      );
      expect(await rowsNamed(input.name)).toEqual([]);
      expect(ak.groups.some((g) => g.pk === "foreign")).toBe(true);
      expect(ak.writes).toEqual([]);
    }));

  // covers: the create vs delete race (spec 0007 AC-2)
  it("fails a create whose row was soft deleted before the pk store, and undoes it", () =>
    inRollback(async (trx) => {
      const { admin, input, rowsNamed } = await setup(trx);
      const ak = fakeAuthentik([]);
      // An admin deletes the not ready row right after its group is made.
      const api = new Proxy(ak.api, {
        get(target, prop, receiver) {
          const value: unknown = Reflect.get(target, prop, receiver);
          if (prop !== "coreGroupsCreate" || typeof value !== "function")
            return typeof value === "function" ? value.bind(target) : value;
          return async (...args: unknown[]) => {
            const created: unknown = await value.apply(target, args);
            await trx
              .updateTable("testbeds")
              .set({ deleted_at: new Date() })
              .where("name", "=", input.name)
              .execute();
            return created;
          };
        },
      }) as CoreApi;
      expect(await createTestbed(api, asConn(trx), input, admin.id)).toEqual({
        ok: false,
        error: "group_failed",
      });
      expect(await rowsNamed(input.name)).toEqual([]);
      const slug = input.name.toLowerCase().replace(" ", "-");
      expect(ak.groups.filter((g) => g.name === `pod-${slug}`)).toEqual([]);
      expect(ak.writes.filter((w) => w.startsWith("DELETE"))).toHaveLength(1);
    }));
});

describe.skipIf(!hasDb)("undoTestbedCreate (AC-11)", () => {
  async function unfinished(trx: Kysely<DB>) {
    const type = await makeType(trx);
    return makeTestbed(trx, type.id, { authentik_group_pk: null });
  }

  it("deletes the group carrying the row's id, then the row", () =>
    inRollback(async (trx) => {
      const row = await unfinished(trx);
      const ak = fakeAuthentik([], {
        groups: [
          fakeGroup("g1", `pod-${row.slug}`, { hol_testbed_id: row.id }),
        ],
      });
      expect(await undoTestbedCreate(ak.api, asConn(trx), row.id)).toEqual({
        ok: true,
        value: true,
      });
      expect(ak.writes).toEqual(["DELETE /core/groups/g1/"]);
      const left = await trx
        .selectFrom("testbeds")
        .select("id")
        .where("id", "=", row.id)
        .execute();
      expect(left).toEqual([]);
    }));

  it("leaves a group whose hol_testbed_id differs", () =>
    inRollback(async (trx) => {
      const row = await unfinished(trx);
      const ak = fakeAuthentik([], {
        groups: [
          fakeGroup("g1", `pod-${row.slug}`, {
            hol_testbed_id: crypto.randomUUID(),
          }),
        ],
      });
      expect(await undoTestbedCreate(ak.api, asConn(trx), row.id)).toEqual({
        ok: true,
        value: true,
      });
      expect(ak.writes).toEqual([]);
    }));

  it("never touches a row whose pk is stored", () =>
    inRollback(async (trx) => {
      const type = await makeType(trx);
      const row = await makeTestbed(trx, type.id);
      const ak = fakeAuthentik([], {
        groups: [
          fakeGroup("g1", `pod-${row.slug}`, { hol_testbed_id: row.id }),
        ],
      });
      expect(await undoTestbedCreate(ak.api, asConn(trx), row.id)).toEqual({
        ok: true,
        value: false,
      });
      expect(ak.writes).toEqual([]);
    }));

  it("keeps the row when Authentik cannot be reached", () =>
    inRollback(async (trx) => {
      const row = await unfinished(trx);
      const ak = fakeAuthentik([], { down: true });
      expect(await undoTestbedCreate(ak.api, asConn(trx), row.id)).toEqual({
        ok: false,
        error: "unavailable",
      });
      const left = await trx
        .selectFrom("testbeds")
        .select("id")
        .where("id", "=", row.id)
        .execute();
      expect(left).toHaveLength(1);
    }));
});

// A ready testbed made through the real create, so it has clients.
async function created(trx: Transaction<DB>) {
  const ctx = await setup(trx);
  const ak = fakeAuthentik([]);
  const r = await createTestbed(ak.api, asConn(trx), ctx.input, ctx.admin.id);
  if (!r.ok) throw new Error(r.error);
  return { ...ctx, id: r.value.id, slug: r.value.slug };
}

// covers: spec 0007 AC-3 (the edit load)
describe.skipIf(!hasDb)("getTestbedForEdit (AC-3)", () => {
  it("returns every field and the clients in order, OS logins included", () =>
    inRollback(async (trx) => {
      const { id, slug, input } = await created(trx);
      expect(await getTestbedForEdit(trx, id)).toEqual({
        ok: true,
        value: {
          name: input.name,
          slug,
          groupName: `pod-${slug}`,
          testbedTypeId: input.testbedTypeId,
          idpApiKeyId: null,
          portalUrl: input.portalUrl,
          lmsUrl: input.lmsUrl,
          clients: input.clients,
        },
      });
    }));

  it("finds no deleted or unknown testbed", () =>
    inRollback(async (trx) => {
      const type = await makeType(trx);
      const tb = await makeTestbed(trx, type.id, { deleted_at: new Date() });
      const missing = { ok: false, error: "not_found" };
      expect(await getTestbedForEdit(trx, tb.id)).toEqual(missing);
      expect(await getTestbedForEdit(trx, crypto.randomUUID())).toEqual(
        missing,
      );
    }));
});

// covers: spec 0007 AC-3, AC-4, AC-5
describe.skipIf(!hasDb)("updateTestbed (AC-3, AC-4, AC-5)", () => {
  it("renames, keeping the slug and group, and audits only the name", () =>
    inRollback(async (trx) => {
      const { id, slug, input, admin } = await created(trx);
      const before = await trx
        .selectFrom("testbeds")
        .select("authentik_group_pk")
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
      const name = `Renamed ${unique()}`;
      expect(
        await updateTestbed(asConn(trx), id, { ...input, name }, admin.id),
      ).toEqual({ ok: true, value: undefined });
      const after = await trx
        .selectFrom("testbeds")
        .select(["name", "slug", "authentik_group_pk"])
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
      expect(after).toEqual({
        name,
        slug,
        authentik_group_pk: before.authentik_group_pk,
      });
      expect(await updates(trx, id)).toEqual([
        {
          actor_user_id: admin.id,
          target_type: "testbed",
          summary: "Testbed updated",
          metadata: { name: { from: input.name, to: name } },
        },
      ]);
    }));

  it("saves a clients only change, audited with counts and no credential", () =>
    inRollback(async (trx) => {
      const { id, input, admin } = await created(trx);
      const [first] = input.clients;
      if (!first) throw new Error("setup has clients");
      const changed = {
        ...input,
        clients: [{ ...first, osPassword: `${PASSWORD}2` }],
      };
      expect(await updateTestbed(asConn(trx), id, changed, admin.id)).toEqual({
        ok: true,
        value: undefined,
      });
      expect(
        (await clientRows(trx, id)).map((c) => [c.position, c.os_password]),
      ).toEqual([[0, `${PASSWORD}2`]]);
      const audited = await updates(trx, id);
      expect(audited.map((a) => a.metadata)).toEqual([
        { clients: { from: 2, to: 1 }, accessChanged: true },
      ]);
      expect(JSON.stringify(audited)).not.toContain(PASSWORD.trim());
      expect(JSON.stringify(audited)).not.toContain("labuser");
    }));

  it("flags a URL change as an access change", () =>
    inRollback(async (trx) => {
      const { id, input, admin } = await created(trx);
      const lmsUrl = "https://lms2.example.test";
      await updateTestbed(asConn(trx), id, { ...input, lmsUrl }, admin.id);
      expect((await updates(trx, id)).map((a) => a.metadata)).toEqual([
        { lmsUrl: { from: input.lmsUrl, to: lmsUrl }, accessChanged: true },
      ]);
    }));

  it("writes nothing for a save that changes nothing", () =>
    inRollback(async (trx) => {
      const { id, input, admin } = await created(trx);
      const clients = await clientRows(trx, id);
      expect(await updateTestbed(asConn(trx), id, input, admin.id)).toEqual({
        ok: true,
        value: undefined,
      });
      expect(await updates(trx, id)).toEqual([]);
      expect(await clientRows(trx, id)).toEqual(clients);
    }));

  it("changes the type under a Current booking, which keeps its own type and times", () =>
    inRollback(async (trx) => {
      const { id, input, admin, type } = await created(trx);
      const learner = await makeUser(trx);
      const booking = await trx
        .insertInto("bookings")
        .values({
          user_id: learner.id,
          testbed_id: id,
          testbed_type_id: type.id,
          starts_at: slot(-1),
          ends_at: slot(1),
          status: "confirmed",
        })
        .returning(["testbed_type_id", "starts_at", "ends_at"])
        .executeTakeFirstOrThrow();
      const other = await makeType(trx);
      expect(
        await updateTestbed(
          asConn(trx),
          id,
          { ...input, testbedTypeId: other.id },
          admin.id,
        ),
      ).toEqual({ ok: true, value: undefined });
      const after = await trx
        .selectFrom("bookings")
        .select(["testbed_type_id", "starts_at", "ends_at"])
        .where("testbed_id", "=", id)
        .executeTakeFirstOrThrow();
      expect(after).toEqual(booking);
    }));

  it("maps a duplicate name, a gone type, and a gone IDP", () =>
    inRollback(async (trx) => {
      const { id, input, admin } = await created(trx);
      const type = await makeType(trx);
      const taken = await makeTestbed(trx, type.id);
      const goneType = await makeType(trx, { deleted_at: new Date() });
      const aiKey = await makeKey(trx, { type: "AI" });
      const update = (patch: Partial<TestbedInput>) =>
        updateTestbed(asConn(trx), id, { ...input, ...patch }, admin.id);

      expect(await update({ name: taken.name.toUpperCase() })).toEqual({
        ok: false,
        error: "duplicate_name",
      });
      expect(await update({ testbedTypeId: goneType.id })).toEqual({
        ok: false,
        error: "type_not_found",
      });
      expect(await update({ idpApiKeyId: aiKey.id })).toEqual({
        ok: false,
        error: "idp_not_found",
      });
      expect(await updates(trx, id)).toEqual([]);
    }));

  it("refuses a deleted testbed, and one still being set up", () =>
    inRollback(async (trx) => {
      const { input, admin, type } = await setup(trx);
      const deleted = await makeTestbed(trx, type.id, {
        deleted_at: new Date(),
      });
      const notReady = await makeTestbed(trx, type.id, {
        authentik_group_pk: null,
      });
      expect(
        await updateTestbed(asConn(trx), deleted.id, input, admin.id),
      ).toEqual({ ok: false, error: "not_found" });
      expect(
        await updateTestbed(asConn(trx), notReady.id, input, admin.id),
      ).toEqual({ ok: false, error: "not_ready" });
    }));
});

// covers: spec 0007 AC-6
describe.skipIf(!hasDb)("deleteTestbed (AC-6)", () => {
  const book = (
    trx: Kysely<DB>,
    testbedId: string,
    typeId: string,
    userId: string,
    from: number,
    to: number,
  ) =>
    trx
      .insertInto("bookings")
      .values({
        user_id: userId,
        testbed_id: testbedId,
        testbed_type_id: typeId,
        starts_at: slot(from),
        ends_at: slot(to),
        status: "confirmed",
      })
      .returning("id")
      .executeTakeFirstOrThrow();

  it("is blocked by Current and Upcoming bookings, labelled by phase", () =>
    inRollback(async (trx) => {
      const { admin, type } = await setup(trx);
      const tb = await makeTestbed(trx, type.id);
      const ana = await makeUser(trx, { name: "Ana" });
      const ben = await makeUser(trx, { name: "Ben" });
      const old = await makeUser(trx, { name: "Old" });
      await book(trx, tb.id, type.id, old.id, -6, -4);
      const upcoming = await book(trx, tb.id, type.id, ben.id, 24, 26);
      const current = await book(trx, tb.id, type.id, ana.id, -1, 1);

      expect(await deleteTestbed(asConn(trx), tb.id, admin.id)).toEqual({
        ok: false,
        error: {
          kind: "blocked",
          blockers: [
            { id: current.id, label: "Ana — Current reservation" },
            { id: upcoming.id, label: "Ben — Upcoming reservation" },
          ],
        },
      });
      const row = await trx
        .selectFrom("testbeds")
        .select("deleted_at")
        .where("id", "=", tb.id)
        .executeTakeFirstOrThrow();
      expect(row.deleted_at).toBeNull();
    }));

  it("soft deletes past a Past booking, audits it, and frees the name", () =>
    inRollback(async (trx) => {
      const { admin, type } = await setup(trx);
      const tb = await makeTestbed(trx, type.id);
      const old = await makeUser(trx);
      await book(trx, tb.id, type.id, old.id, -6, -4);

      expect(await deleteTestbed(asConn(trx), tb.id, admin.id)).toEqual({
        ok: true,
        value: undefined,
      });
      expect(await lockBookableTestbed(trx, tb.id)).toEqual({
        ok: false,
        error: "not_bookable",
      });
      const audit = await trx
        .selectFrom("audit_events")
        .select(["actor_user_id", "summary", "metadata"])
        .where("target_id", "=", tb.id)
        .where("action", "=", "testbed.deleted")
        .execute();
      expect(audit).toEqual([
        {
          actor_user_id: admin.id,
          summary: "Testbed deleted",
          metadata: { slug: tb.slug, groupPk: tb.authentik_group_pk },
        },
      ]);
      expect(
        await attempt(trx, () =>
          makeTestbed(trx, type.id, { name: tb.name.toUpperCase() }),
        ),
      ).toBeUndefined();
      expect(
        await attempt(trx, () => makeTestbed(trx, type.id, { slug: tb.slug })),
      ).toMatchObject({ constraint: "testbeds_slug_uq" });
      expect(await deleteTestbed(asConn(trx), tb.id, admin.id)).toEqual({
        ok: false,
        error: { kind: "not_found" },
      });
    }));

  it("records a null group pk for a not ready testbed", () =>
    inRollback(async (trx) => {
      const { admin, type } = await setup(trx);
      const tb = await makeTestbed(trx, type.id, { authentik_group_pk: null });
      await deleteTestbed(asConn(trx), tb.id, admin.id);
      const audit = await trx
        .selectFrom("audit_events")
        .select("metadata")
        .where("target_id", "=", tb.id)
        .where("action", "=", "testbed.deleted")
        .executeTakeFirstOrThrow();
      expect(audit.metadata).toEqual({ slug: tb.slug, groupPk: null });
    }));
});
