import { sql, type Kysely, type Transaction } from "kysely";
import { afterAll, describe, expect, it } from "vitest";
import type { TestbedInput } from "@/lib/catalog-input";
import type { CoreApi } from "@/server/authentik/client";
import {
  fakeAuthentik,
  fakeGroup,
  groupWrites,
  markedGroup,
} from "@/server/authentik/testing";
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
  updateTestbed,
} from "./testbeds";
import { createTestbedType, listTestbedTypes } from "./testbed-types";

const unique = () => crypto.randomUUID().slice(0, 8);

// A value that must never reach an audit row.
const PASSWORD = `pw ${unique()} `;

async function setup(trx: Kysely<DB>) {
  const admin = await makeUser(trx, { role: "admin", company: null });
  const type = await makeType(trx);
  const tag = unique();
  // The name is the name of a group the owner already made and marked.
  const name = `NileLab${tag}Admin`;
  const input: TestbedInput = {
    name: `Friendly ${tag}`,
    groupName: name,
    domain: `lab-${tag}.example.test`,
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
  const group = markedGroup(crypto.randomUUID(), name);
  // The fake Authentik holds the owner's group; `extra` adds or changes more.
  const authentik = (
    extra: Parameters<typeof fakeAuthentik>[1] & object = {},
  ) =>
    fakeAuthentik([], {
      ...extra,
      groups: [group, ...(extra.groups ?? [])],
    });
  const rowsNamed = (n: string) =>
    trx
      .selectFrom("testbeds")
      .select(["id", "slug", "domain", "authentik_group_pk"])
      .where(sql<string>`lower(group_name)`, "=", n.toLowerCase())
      .execute();
  const audits = (targetId: string) =>
    trx
      .selectFrom("audit_events")
      .select("action")
      .where("target_id", "=", targetId)
      .orderBy("action")
      .execute();
  return { admin, type, input, group, authentik, rowsNamed, audits };
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

// covers: spec 0007 AC-1, spec 0017 AC-8, Value sourcing (list)
describe.skipIf(!hasDb)("listTestbedsForAdmin (AC-1, spec 0017 AC-8)", () => {
  it("lists live testbeds by name ignoring case, with type, domain, IDP, and client count", () =>
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
          groupName: a.group_name,
          typeName: type.name,
          domain: a.domain,
          idpName: null,
          clientCount: 0,
        },
        {
          id: b.id,
          name: b.name,
          groupName: b.group_name,
          typeName: type.name,
          domain: b.domain,
          idpName: key.name,
          clientCount: 3,
        },
      ]);
      // No client details, so no OS login, in the list payload.
      expect(JSON.stringify(mine)).not.toContain(PASSWORD);
    }));
});

// Runs `after` once the group lookup has answered, standing in for a second
// admin saving between this create's precheck and its insert.
const racing = (api: CoreApi, after: () => Promise<unknown>): CoreApi => {
  // The first group list may be the admin group lookup, so only the list by
  // name (the one with a `name` argument) triggers it, and only once.
  let fired = false;
  return new Proxy(api, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      if (prop !== "coreGroupsList") return value.bind(target);
      return async (...args: unknown[]) => {
        const listed: unknown = await value.apply(target, args);
        const byName = (args[0] as { name?: string } | undefined)?.name;
        if (!fired && byName !== undefined && byName !== "hol-admins") {
          fired = true;
          await after();
        }
        return listed;
      };
    },
  });
};

// covers: spec 0017 AC-2, AC-3, AC-4, AC-7; spec 0004 AC-2; spec 0007 AC-2
describe.skipIf(!hasDb)("createTestbed (spec 0017 AC-2, AC-3)", () => {
  it("inserts one row with the domain and the group's pk, and audits it", () =>
    inRollback(async (trx) => {
      const { admin, input, group, authentik, rowsNamed, audits } =
        await setup(trx);
      const ak = authentik();
      const r = await createTestbed(ak.api, asConn(trx), input, admin.id);
      if (!r.ok) throw new Error(r.error);

      expect(await rowsNamed(input.groupName)).toEqual([
        {
          id: r.value.id,
          slug: r.value.slug,
          domain: input.domain,
          authentik_group_pk: group.pk,
        },
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
      // One audit row, with the domain and the stored pk, and no group row.
      expect(await audits(r.value.id)).toEqual([{ action: "testbed.created" }]);
      expect(await audits(group.pk)).toEqual([]);
      const row = await trx
        .selectFrom("audit_events")
        .select("metadata")
        .where("target_id", "=", r.value.id)
        .executeTakeFirstOrThrow();
      expect(row.metadata).toEqual({
        slug: r.value.slug,
        name: input.name,
        groupName: input.groupName,
        domain: input.domain,
        groupPk: group.pk,
        clients: 2,
      });
      // The app writes no group: it only read it, without its members.
      expect(ak.writes).toEqual([]);
      expect(groupWrites(ak.writes)).toEqual([]);
      expect(ak.groupReads.every((g) => g.includeUsers === "false")).toBe(true);
      const listed = await listTestbedsForAdmin(trx);
      expect(listed.find((t) => t.id === r.value.id)?.domain).toBe(
        input.domain,
      );
    }));

  it("stores the name as typed and the group name exactly as the group is named", () =>
    inRollback(async (trx) => {
      const { admin, input, group, authentik } = await setup(trx);
      const r = await createTestbed(
        authentik().api,
        asConn(trx),
        input,
        admin.id,
      );
      if (!r.ok) throw new Error(r.error);
      const row = await trx
        .selectFrom("testbeds")
        .select(["name", "group_name"])
        .where("id", "=", r.value.id)
        .executeTakeFirstOrThrow();
      expect(row).toEqual({ name: input.name, group_name: group.name });
    }));

  it("stores a live IDP key", () =>
    inRollback(async (trx) => {
      const { admin, input, authentik } = await setup(trx);
      const key = await makeKey(trx);
      const r = await createTestbed(
        authentik().api,
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
      const { admin, input, authentik, rowsNamed, audits } = await setup(trx);
      const key = await makeKey(trx, over);
      const ak = authentik();
      expect(
        await createTestbed(
          ak.api,
          asConn(trx),
          { ...input, idpApiKeyId: key.id },
          admin.id,
        ),
      ).toEqual({ ok: false, error: "idp_not_found" });
      expect(await rowsNamed(input.groupName)).toEqual([]);
      expect(await audits(admin.id)).toEqual([]);
      expect(ak.writes).toEqual([]);
    }),
  );

  it("refuses a missing or deleted type and writes nothing", () =>
    inRollback(async (trx) => {
      const { admin, input, type, authentik, rowsNamed } = await setup(trx);
      await trx
        .updateTable("testbed_types")
        .set({ deleted_at: new Date() })
        .where("id", "=", type.id)
        .execute();
      expect(
        await createTestbed(authentik().api, asConn(trx), input, admin.id),
      ).toEqual({ ok: false, error: "type_not_found" });
      expect(await rowsNamed(input.groupName)).toEqual([]);
    }));

  it("suffixes a slug already taken", () =>
    inRollback(async (trx) => {
      const { admin, input, authentik, group } = await setup(trx);
      // "Lab x" and "Lab-x" are two names with one slug.
      const tag = unique();
      const spaced = {
        ...input,
        name: `Spaced ${tag}`,
        groupName: `Lab ${tag}`,
        domain: `a-${tag}.test`,
      };
      const dashed = {
        ...input,
        name: `Dashed ${tag}`,
        groupName: `Lab-${tag}`,
        domain: `b-${tag}.test`,
      };
      const ak = authentik({
        groups: [
          markedGroup(crypto.randomUUID(), spaced.groupName),
          markedGroup(crypto.randomUUID(), dashed.groupName),
        ],
      });
      expect(group.name).not.toBe(spaced.groupName);
      const first = await createTestbed(ak.api, asConn(trx), spaced, admin.id);
      if (!first.ok) throw new Error(first.error);
      expect(
        await createTestbed(ak.api, asConn(trx), dashed, admin.id),
      ).toMatchObject({
        ok: true,
        value: { slug: `${first.value.slug}-2` },
      });
    }));

  // covers: AC-2, the name and the domain are unique among live testbeds
  it("refuses a taken name ignoring case, before it calls Authentik", () =>
    inRollback(async (trx) => {
      const { admin, input, authentik, rowsNamed } = await setup(trx);
      const first = await createTestbed(
        authentik().api,
        asConn(trx),
        input,
        admin.id,
      );
      if (!first.ok) throw new Error(first.error);

      // Authentik is down, yet the duplicate message still shows.
      const down = authentik({ down: true });
      expect(
        await createTestbed(
          down.api,
          asConn(trx),
          { ...input, name: input.name.toUpperCase(), domain: "other.test" },
          admin.id,
        ),
      ).toEqual({ ok: false, error: "duplicate_name" });
      const quiet = authentik();
      await createTestbed(
        quiet.api,
        asConn(trx),
        { ...input, domain: "another.test" },
        admin.id,
      );
      expect(quiet.groupReads).toEqual([]);
      expect(await rowsNamed(input.groupName)).toHaveLength(1);
    }));

  it("refuses a taken domain, and shows only the name error when both are taken", () =>
    inRollback(async (trx) => {
      const { admin, input, authentik } = await setup(trx);
      const other = markedGroup(`other-${unique()}`, `Other${unique()}Admin`);
      const ak = authentik({ groups: [other] });
      const first = await createTestbed(ak.api, asConn(trx), input, admin.id);
      if (!first.ok) throw new Error(first.error);

      expect(
        await createTestbed(
          ak.api,
          asConn(trx),
          { ...input, name: `Other ${unique()}`, groupName: other.name },
          admin.id,
        ),
      ).toEqual({ ok: false, error: "duplicate_domain" });
      expect(await createTestbed(ak.api, asConn(trx), input, admin.id)).toEqual(
        { ok: false, error: "duplicate_name" },
      );
    }));

  it("lets a soft delete free the name, the domain, and the group for reuse", () =>
    inRollback(async (trx) => {
      const { admin, input, authentik, rowsNamed } = await setup(trx);
      const ak = authentik();
      const first = await createTestbed(ak.api, asConn(trx), input, admin.id);
      if (!first.ok) throw new Error(first.error);
      await deleteTestbed(asConn(trx), first.value.id, admin.id);

      const again = await createTestbed(ak.api, asConn(trx), input, admin.id);
      expect(again).toMatchObject({
        ok: true,
        value: { slug: `${first.value.slug}-2` },
      });
      expect(await rowsNamed(input.groupName)).toHaveLength(2);
    }));

  // covers: two admins saving at once get the message, never an exception
  it("tells a name taken between the precheck and the insert from a slug clash", () =>
    inRollback(async (trx) => {
      const { admin, input, type, authentik } = await setup(trx);
      const api = racing(authentik().api, () =>
        makeTestbed(trx, type.id, { name: input.name.toUpperCase() }),
      );
      expect(await createTestbed(api, asConn(trx), input, admin.id)).toEqual({
        ok: false,
        error: "duplicate_name",
      });
    }));

  it("tells a domain taken between the precheck and the insert", () =>
    inRollback(async (trx) => {
      const { admin, input, type, authentik } = await setup(trx);
      const api = racing(authentik().api, () =>
        makeTestbed(trx, type.id, { domain: input.domain }),
      );
      expect(await createTestbed(api, asConn(trx), input, admin.id)).toEqual({
        ok: false,
        error: "duplicate_domain",
      });
    }));

  // covers: AC-3, one live testbed per Authentik group
  it("refuses a group another live testbed already uses", () =>
    inRollback(async (trx) => {
      const { admin, input, type, group, authentik, rowsNamed } =
        await setup(trx);
      await makeTestbed(trx, type.id, { authentik_group_pk: group.pk });
      expect(
        await createTestbed(authentik().api, asConn(trx), input, admin.id),
      ).toEqual({ ok: false, error: "group_in_use" });
      expect(await rowsNamed(input.groupName)).toEqual([]);
    }));

  it("takes a group a deleted testbed used", () =>
    inRollback(async (trx) => {
      const { admin, input, type, group, authentik } = await setup(trx);
      await makeTestbed(trx, type.id, {
        authentik_group_pk: group.pk,
        deleted_at: new Date(),
      });
      const r = await createTestbed(
        authentik().api,
        asConn(trx),
        input,
        admin.id,
      );
      expect(r.ok).toBe(true);
    }));

  // covers: AC-3, the group refusals leave no row and no audit row
  it.each([
    [
      "no group has that name",
      (name: string) => ({ groups: [], rename: `${name}Missing` }),
      "group_not_found",
    ],
    [
      "the group has no marker",
      (name: string) => ({ groups: [fakeGroup("plain-pk", name)], drop: true }),
      "group_not_testbed_group",
    ],
    [
      "the marker is the string true",
      (name: string) => ({
        groups: [fakeGroup("str-pk", name, { hol_testbed_group: "true" })],
        drop: true,
      }),
      "group_not_testbed_group",
    ],
    [
      "the group is a superuser group",
      (name: string) => ({
        groups: [markedGroup("su-pk", name, { is_superuser: true })],
        drop: true,
      }),
      "group_not_testbed_group",
    ],
    [
      "the group has a parent",
      (name: string) => ({
        groups: [markedGroup("par-pk", name, { parents: ["admins-uuid"] })],
        drop: true,
      }),
      "group_not_testbed_group",
    ],
    [
      "the group has a role",
      (name: string) => ({
        groups: [markedGroup("role-pk", name, { roles: ["r1"] })],
        drop: true,
      }),
      "group_not_testbed_group",
    ],
    [
      "two groups share the exact name",
      (name: string) => ({
        groups: [markedGroup("dup-pk", name)],
      }),
      "group_not_testbed_group",
    ],
  ] as const)("refuses when %s", (_, build, error) =>
    inRollback(async (trx) => {
      const { admin, input, group, rowsNamed } = await setup(trx);
      const { groups, drop, rename } = build(input.groupName) as {
        groups: ReturnType<typeof fakeGroup>[];
        drop?: boolean;
        rename?: string;
      };
      // `drop` replaces the setup's usable group; `rename` asks for a
      // name no group has.
      const ak = fakeAuthentik([], {
        groups: [...(drop ? [] : [group]), ...groups],
      });
      const asked = { ...input, groupName: rename ?? input.groupName };
      expect(await createTestbed(ak.api, asConn(trx), asked, admin.id)).toEqual(
        { ok: false, error },
      );
      expect(await rowsNamed(asked.groupName)).toEqual([]);
      expect(ak.writes).toEqual([]);
      const made = await trx
        .selectFrom("audit_events")
        .select("id")
        .where("actor_user_id", "=", admin.id)
        .execute();
      expect(made).toEqual([]);
    }),
  );

  it("refuses hol-admins even when it is marked", () =>
    inRollback(async (trx) => {
      const { admin, input, rowsNamed } = await setup(trx);
      const ak = fakeAuthentik([]);
      const admins = ak.groups.find((g) => g.name === "hol-admins");
      if (admins) admins.attributes = { hol_testbed_group: true };
      const asked = { ...input, groupName: "hol-admins" };
      expect(await createTestbed(ak.api, asConn(trx), asked, admin.id)).toEqual(
        { ok: false, error: "group_not_testbed_group" },
      );
      expect(await rowsNamed("hol-admins")).toEqual([]);
    }));

  it("accepts only the exact name among near names", () =>
    inRollback(async (trx) => {
      const { admin, input, group, authentik } = await setup(trx);
      const ak = authentik({
        groups: [
          markedGroup("near-1", `${input.groupName}X`),
          markedGroup("near-2", input.groupName.toLowerCase()),
        ],
      });
      const r = await createTestbed(ak.api, asConn(trx), input, admin.id);
      if (!r.ok) throw new Error(r.error);
      const row = await trx
        .selectFrom("testbeds")
        .select("authentik_group_pk")
        .where("id", "=", r.value.id)
        .executeTakeFirstOrThrow();
      expect(row.authentik_group_pk).toBe(group.pk);
    }));

  // covers: AC-3, an unreachable or unreadable Authentik is not a refusal
  it.each([
    ["is down", { down: true }],
    [
      "answers 403",
      {
        reply: (_m: string, p: string) =>
          p === "/core/groups/"
            ? new Response("{}", { status: 403 })
            : undefined,
      },
    ],
    ["answers 500", { fail: (_m: string, p: string) => p === "/core/groups/" }],
  ])("says Authentik is unavailable when it %s, writing nothing", (_, over) =>
    inRollback(async (trx) => {
      const { admin, input, authentik, rowsNamed } = await setup(trx);
      expect(
        await createTestbed(authentik(over).api, asConn(trx), input, admin.id),
      ).toEqual({ ok: false, error: "authentik_unavailable" });
      expect(await rowsNamed(input.groupName)).toEqual([]);
    }),
  );
});

// A testbed made through the real create, so it has clients.
async function created(trx: Transaction<DB>) {
  const ctx = await setup(trx);
  const r = await createTestbed(
    ctx.authentik().api,
    asConn(trx),
    ctx.input,
    ctx.admin.id,
  );
  if (!r.ok) throw new Error(r.error);
  return { ...ctx, id: r.value.id, slug: r.value.slug };
}

// covers: spec 0007 AC-3 (the edit load), spec 0017 AC-5 (domain, no group)
describe.skipIf(!hasDb)("getTestbedForEdit (AC-3)", () => {
  it("returns every field and the clients in order, OS logins included", () =>
    inRollback(async (trx) => {
      const { id, slug, input } = await created(trx);
      expect(await getTestbedForEdit(trx, id)).toEqual({
        ok: true,
        value: {
          name: input.name,
          groupName: input.groupName,
          slug,
          domain: input.domain,
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

// A booking on the testbed, from `from` to `to` hours from now.
const book = (
  trx: Kysely<DB>,
  testbedId: string,
  typeId: string,
  userId: string,
  from: number,
  to: number,
  status: "confirmed" | "provisioning" = "confirmed",
) =>
  trx
    .insertInto("bookings")
    .values({
      user_id: userId,
      testbed_id: testbedId,
      testbed_type_id: typeId,
      starts_at: slot(from),
      ends_at: slot(to),
      status,
    })
    .returning("id")
    .executeTakeFirstOrThrow();

const domainOf = async (trx: Kysely<DB>, id: string) =>
  (
    await trx
      .selectFrom("testbeds")
      .select("domain")
      .where("id", "=", id)
      .executeTakeFirstOrThrow()
  ).domain;

// covers: spec 0007 AC-3, AC-4, AC-5; spec 0017 AC-5, AC-6, AC-7
describe.skipIf(!hasDb)("updateTestbed (AC-3, AC-4, AC-5)", () => {
  it("changes the domain, keeping the name, slug, and group, and audits only the domain", () =>
    inRollback(async (trx) => {
      const { id, slug, input, admin } = await created(trx);
      const before = await trx
        .selectFrom("testbeds")
        .select("authentik_group_pk")
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
      const { name } = input;
      const { groupName, ...fields } = input;
      expect(groupName).toBeTruthy();
      const domain = `moved-${unique()}.example.test`;
      expect(
        await updateTestbed(asConn(trx), id, { ...fields, domain }, admin.id),
      ).toEqual({ ok: true, value: { name } });
      const after = await trx
        .selectFrom("testbeds")
        .select(["name", "slug", "domain", "authentik_group_pk"])
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
      expect(after).toEqual({
        name,
        slug,
        domain,
        authentik_group_pk: before.authentik_group_pk,
      });
      expect(await updates(trx, id)).toEqual([
        {
          actor_user_id: admin.id,
          target_type: "testbed",
          summary: "Testbed updated",
          metadata: { domain: { from: input.domain, to: domain } },
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
        value: { name: input.name },
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
        value: { name: input.name },
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
      ).toEqual({ ok: true, value: { name: input.name } });
      const after = await trx
        .selectFrom("bookings")
        .select(["testbed_type_id", "starts_at", "ends_at"])
        .where("testbed_id", "=", id)
        .executeTakeFirstOrThrow();
      expect(after).toEqual(booking);
    }));

  // covers: AC-2, a taken domain; AC-6, the error order
  it("maps a gone type, a gone IDP, and a taken domain", () =>
    inRollback(async (trx) => {
      const { id, input, admin } = await created(trx);
      const type = await makeType(trx);
      const taken = await makeTestbed(trx, type.id);
      const goneType = await makeType(trx, { deleted_at: new Date() });
      const aiKey = await makeKey(trx, { type: "AI" });
      const update = (patch: Partial<TestbedInput>) =>
        updateTestbed(asConn(trx), id, { ...input, ...patch }, admin.id);

      expect(await update({ domain: taken.domain ?? "" })).toEqual({
        ok: false,
        error: "duplicate_domain",
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
      expect(await domainOf(trx, id)).toBe(input.domain);
    }));

  it("refuses a deleted or unknown testbed", () =>
    inRollback(async (trx) => {
      const { input, admin, type } = await setup(trx);
      const deleted = await makeTestbed(trx, type.id, {
        deleted_at: new Date(),
      });
      expect(
        await updateTestbed(asConn(trx), deleted.id, input, admin.id),
      ).toEqual({ ok: false, error: "not_found" });
      expect(
        await updateTestbed(asConn(trx), crypto.randomUUID(), input, admin.id),
      ).toEqual({ ok: false, error: "not_found" });
    }));
});

// covers: spec 0017 AC-6 (the domain lock)
describe.skipIf(!hasDb)("updateTestbed domain lock (spec 0017 AC-6)", () => {
  const moved = () => `moved-${unique()}.example.test`;

  it.each([
    ["Current", -1, 1, "confirmed"],
    ["Upcoming", 24, 26, "confirmed"],
    ["Pending", 24, 26, "provisioning"],
  ] as const)(
    "refuses a domain change under a %s booking and writes nothing",
    (_, from, to, status) =>
      inRollback(async (trx) => {
        const { id, input, admin, type } = await created(trx);
        const learner = await makeUser(trx);
        await book(trx, id, type.id, learner.id, from, to, status);
        expect(
          await updateTestbed(
            asConn(trx),
            id,
            { ...input, domain: moved(), lmsUrl: "https://lms3.example.test" },
            admin.id,
          ),
        ).toEqual({ ok: false, error: "domain_locked" });
        expect(await domainOf(trx, id)).toBe(input.domain);
        expect(await updates(trx, id)).toEqual([]);
        const row = await trx
          .selectFrom("testbeds")
          .select("lms_url")
          .where("id", "=", id)
          .executeTakeFirstOrThrow();
        expect(row.lms_url).toBe(input.lmsUrl);
      }),
  );

  it("still saves other fields under a Current booking while the domain stays", () =>
    inRollback(async (trx) => {
      const { id, input, admin, type } = await created(trx);
      const learner = await makeUser(trx);
      await book(trx, id, type.id, learner.id, -1, 1);
      const lmsUrl = "https://lms4.example.test";
      expect(
        await updateTestbed(asConn(trx), id, { ...input, lmsUrl }, admin.id),
      ).toEqual({ ok: true, value: { name: input.name } });
    }));

  it("saves a domain change with only a Past or cancelled booking", () =>
    inRollback(async (trx) => {
      const { id, input, admin, type } = await created(trx);
      const learner = await makeUser(trx);
      await book(trx, id, type.id, learner.id, -6, -4);
      const domain = moved();
      expect(
        await updateTestbed(asConn(trx), id, { ...input, domain }, admin.id),
      ).toEqual({ ok: true, value: { name: input.name } });
      expect(await domainOf(trx, id)).toBe(domain);
    }));

  it("does not let a booking on another testbed block the change", () =>
    inRollback(async (trx) => {
      const { id, input, admin, type } = await created(trx);
      const other = await makeTestbed(trx, type.id);
      const learner = await makeUser(trx);
      await book(trx, other.id, type.id, learner.id, -1, 1);
      const domain = moved();
      expect(
        await updateTestbed(asConn(trx), id, { ...input, domain }, admin.id),
      ).toMatchObject({ ok: true });
      expect(await domainOf(trx, id)).toBe(domain);
    }));

  it("reports the lock before a taken domain, and a gone type before the lock", () =>
    inRollback(async (trx) => {
      const { id, input, admin, type } = await created(trx);
      const other = await makeTestbed(trx, type.id);
      const learner = await makeUser(trx);
      await book(trx, id, type.id, learner.id, -1, 1);
      expect(
        await updateTestbed(
          asConn(trx),
          id,
          { ...input, domain: other.domain ?? "" },
          admin.id,
        ),
      ).toEqual({ ok: false, error: "domain_locked" });
      const goneType = await makeType(trx, { deleted_at: new Date() });
      expect(
        await updateTestbed(
          asConn(trx),
          id,
          { ...input, domain: moved(), testbedTypeId: goneType.id },
          admin.id,
        ),
      ).toEqual({ ok: false, error: "type_not_found" });
    }));
});

// covers: spec 0007 AC-6
describe.skipIf(!hasDb)("deleteTestbed (AC-6)", () => {
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

  it("soft deletes past a Past booking, audits it, and frees the name, domain, and group", () =>
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
          makeTestbed(trx, type.id, {
            name: tb.name.toUpperCase(),
            domain: tb.domain,
            authentik_group_pk: tb.authentik_group_pk,
          }),
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
});

// covers: spec 0007 AC-3 (edges of the edit save)
describe.skipIf(!hasDb)("updateTestbed edges (AC-3)", () => {
  it("reorders and grows the clients, each login staying with its client", () =>
    inRollback(async (trx) => {
      const { id, input, admin } = await created(trx);
      const [wired, air] = input.clients;
      if (!wired || !air) throw new Error("setup has two clients");
      const extra = {
        kind: "wired",
        name: "Wired 2",
        url: "https://w2.example.test",
        osUsername: "second",
        osPassword: "two",
      } as const;
      const clients = [air, wired, extra];

      expect(
        await updateTestbed(asConn(trx), id, { ...input, clients }, admin.id),
      ).toEqual({ ok: true, value: { name: input.name } });
      expect(
        (await clientRows(trx, id)).map((c) => [
          c.position,
          c.name,
          c.os_username,
          c.os_password,
        ]),
      ).toEqual([
        [0, "Air 1", null, null],
        [1, "Wired 1", "labuser", PASSWORD],
        [2, "Wired 2", "second", "two"],
      ]);
      expect(await getTestbedForEdit(trx, id)).toMatchObject({
        ok: true,
        value: { clients },
      });
      expect((await updates(trx, id)).map((a) => a.metadata)).toEqual([
        { clients: { from: 2, to: 3 }, accessChanged: true },
      ]);
    }));

  it("removes every client", () =>
    inRollback(async (trx) => {
      const { id, input, admin } = await created(trx);
      await updateTestbed(asConn(trx), id, { ...input, clients: [] }, admin.id);
      expect(await clientRows(trx, id)).toEqual([]);
      const listed = (await listTestbedsForAdmin(trx)).find((t) => t.id === id);
      expect(listed?.clientCount).toBe(0);
    }));

  it("refuses a soft deleted IDP key and leaves the row as it was", () =>
    inRollback(async (trx) => {
      const { id, input, admin } = await created(trx);
      const gone = await makeKey(trx, { deleted_at: new Date() });
      expect(
        await updateTestbed(
          asConn(trx),
          id,
          { ...input, idpApiKeyId: gone.id },
          admin.id,
        ),
      ).toEqual({ ok: false, error: "idp_not_found" });
      const row = await trx
        .selectFrom("testbeds")
        .select(["name", "idp_api_key_id"])
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
      expect(row).toEqual({ name: input.name, idp_api_key_id: null });
      expect(await updates(trx, id)).toEqual([]);
    }));

  // The dialog shows a stale IDP as None, so saving sends none.
  it("clears an IDP key deleted since it was chosen, auditing the id change", () =>
    inRollback(async (trx) => {
      const { admin, input, authentik } = await setup(trx);
      const key = await makeKey(trx);
      const r = await createTestbed(
        authentik().api,
        asConn(trx),
        { ...input, idpApiKeyId: key.id },
        admin.id,
      );
      if (!r.ok) throw new Error(r.error);
      await trx
        .updateTable("api_keys")
        .set({ deleted_at: new Date() })
        .where("id", "=", key.id)
        .execute();
      expect(await getTestbedForEdit(trx, r.value.id)).toMatchObject({
        ok: true,
        value: { idpApiKeyId: key.id },
      });

      expect(
        await updateTestbed(
          asConn(trx),
          r.value.id,
          { ...input, idpApiKeyId: null },
          admin.id,
        ),
      ).toEqual({ ok: true, value: { name: input.name } });
      expect((await updates(trx, r.value.id)).map((a) => a.metadata)).toEqual([
        { idpApiKeyId: { from: key.id, to: null } },
      ]);
    }));

  it("refuses an unknown id", () =>
    inRollback(async (trx) => {
      const { input, admin } = await setup(trx);
      expect(
        await updateTestbed(asConn(trx), crypto.randomUUID(), input, admin.id),
      ).toEqual({ ok: false, error: "not_found" });
    }));
});

// covers: spec 0007 AC-6 (edges of the delete)
describe.skipIf(!hasDb)("deleteTestbed edges (AC-6)", () => {
  it("finds no unknown testbed, and writes no audit row", () =>
    inRollback(async (trx) => {
      const { admin } = await setup(trx);
      const id = crypto.randomUUID();
      expect(await deleteTestbed(asConn(trx), id, admin.id)).toEqual({
        ok: false,
        error: { kind: "not_found" },
      });
      expect(
        await trx
          .selectFrom("audit_events")
          .select("id")
          .where("target_id", "=", id)
          .execute(),
      ).toEqual([]);
    }));
});

// covers: spec 0018 AC-3, AC-4, AC-6
describe.skipIf(!hasDb)("testbed Name and Group Name (spec 0018)", () => {
  it("renames with an Upcoming and a Current booking, calling no Authentik and queuing no job", () =>
    inRollback(async (trx) => {
      const { id, input, admin } = await created(trx);
      const [current, upcoming] = [await makeUser(trx), await makeUser(trx)];
      await trx
        .insertInto("bookings")
        .values(
          [
            [current.id, -1, 1],
            [upcoming.id, 24, 26],
          ].map(([user, from, to]) => ({
            user_id: String(user),
            testbed_id: id,
            testbed_type_id: input.testbedTypeId,
            starts_at: slot(Number(from)),
            ends_at: slot(Number(to)),
            status: "confirmed" as const,
          })),
        )
        .execute();
      const jobsBefore = await trx
        .selectFrom("jobs")
        .select(sql<number>`count(*)::int`.as("n"))
        .executeTakeFirstOrThrow();

      const renamed = { ...input, name: "Wireless Lab 1" };
      expect(await updateTestbed(asConn(trx), id, renamed, admin.id)).toEqual({
        ok: true,
        value: { name: "Wireless Lab 1" },
      });
      const row = await trx
        .selectFrom("testbeds")
        .select(["name", "group_name"])
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
      expect(row).toEqual({
        name: "Wireless Lab 1",
        group_name: input.groupName,
      });
      expect(await updates(trx, id)).toMatchObject([
        { metadata: { name: { from: input.name, to: "Wireless Lab 1" } } },
      ]);
      const jobsAfter = await trx
        .selectFrom("jobs")
        .select(sql<number>`count(*)::int`.as("n"))
        .executeTakeFirstOrThrow();
      expect(jobsAfter.n).toBe(jobsBefore.n);
    }));

  it("refuses a name another live testbed has, but allows a case only rename", () =>
    inRollback(async (trx) => {
      const { id, input, admin } = await created(trx);
      const type = await makeType(trx);
      const other = await makeTestbed(trx, type.id);
      expect(
        await updateTestbed(
          asConn(trx),
          id,
          { ...input, name: other.name.toUpperCase() },
          admin.id,
        ),
      ).toEqual({ ok: false, error: "duplicate_name" });
      expect(
        await updateTestbed(
          asConn(trx),
          id,
          { ...input, name: input.name.toLowerCase() },
          admin.id,
        ),
      ).toEqual({ ok: true, value: { name: input.name.toLowerCase() } });
    }));

  // covers: spec 0018 AC-4, the update error order puts duplicate_name before duplicate_domain
  it("reports a taken name before a taken domain, and a taken domain when the name is unchanged", () =>
    inRollback(async (trx) => {
      const { id, input, admin } = await created(trx);
      const type = await makeType(trx);
      const other = await makeTestbed(trx, type.id);
      const update = (patch: Partial<TestbedInput>) =>
        updateTestbed(asConn(trx), id, { ...input, ...patch }, admin.id);

      expect(
        await update({ name: other.name, domain: other.domain ?? "" }),
      ).toEqual({ ok: false, error: "duplicate_name" });
      expect(await update({ domain: other.domain ?? "" })).toEqual({
        ok: false,
        error: "duplicate_domain",
      });
      expect(await updates(trx, id)).toEqual([]);
    }));

  it("lets a soft delete free the group name, and refuses a live duplicate in the database", () =>
    inRollback(async (trx) => {
      const type = await makeType(trx);
      const live = await makeTestbed(trx, type.id);
      await makeTestbed(trx, type.id, {
        group_name: live.group_name,
        deleted_at: new Date(),
      });
      await expect(
        makeTestbed(trx, type.id, {
          group_name: live.group_name.toUpperCase(),
        }),
      ).rejects.toMatchObject({ constraint: "testbeds_group_name_lower_uq" });
    }));

  it("refuses an empty or untrimmed group name in the database", () =>
    inRollback(async (trx) => {
      const type = await makeType(trx);
      await expect(
        makeTestbed(trx, type.id, { group_name: " padded " }),
      ).rejects.toMatchObject({ constraint: "testbeds_group_name_trimmed" });
    }));

  it("tells a group name taken between the precheck and the insert", () =>
    inRollback(async (trx) => {
      const { admin, input, type, authentik } = await setup(trx);
      const api = racing(authentik().api, () =>
        makeTestbed(trx, type.id, {
          group_name: input.groupName.toUpperCase(),
        }),
      );
      expect(await createTestbed(api, asConn(trx), input, admin.id)).toEqual({
        ok: false,
        error: "duplicate_group_name",
      });
    }));

  it("checks the name before the group name before the domain, with Authentik down", () =>
    inRollback(async (trx) => {
      const { admin, input, authentik } = await setup(trx);
      const first = await createTestbed(
        authentik().api,
        asConn(trx),
        input,
        admin.id,
      );
      if (!first.ok) throw new Error(first.error);
      const down = authentik({ down: true }).api;
      const create = (over: object) =>
        createTestbed(down, asConn(trx), { ...input, ...over }, admin.id);
      const fresh = `Other ${unique()}`;
      expect(await create({})).toEqual({
        ok: false,
        error: "duplicate_name",
      });
      expect(await create({ name: fresh })).toEqual({
        ok: false,
        error: "duplicate_group_name",
      });
      expect(await create({ name: fresh, groupName: `G${unique()}` })).toEqual({
        ok: false,
        error: "duplicate_domain",
      });
    }));
});
