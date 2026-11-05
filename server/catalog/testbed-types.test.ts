import type {
  Kysely,
  KyselyPlugin,
  RawNode,
  SelectQueryNode,
  Transaction,
} from "kysely";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  fakeAuthentik,
  fakeGroup,
  markedGroup,
} from "@/server/authentik/testing";
import { db } from "@/server/db";
import {
  asConn,
  hasDb,
  inRollback,
  makeTestbed,
  makeType,
  makeUser,
  slot,
} from "@/server/db/testing";
import type { DB } from "@/server/db/types";
import {
  createTestbedType,
  deleteTestbedType,
  listTestbedTypes,
  updateTestbedType,
} from "./testbed-types";

// Feature 7: edit, delete, and the usage count. Rules from spec 0002 AC-4,
// AC-5, AC-14.

const unique = () => crypto.randomUUID().slice(0, 8);

const auditsFor = (trx: Kysely<DB>, targetId: string) =>
  trx
    .selectFrom("audit_events")
    .select(["action", "actor_user_id", "metadata"])
    .where("target_id", "=", targetId)
    .orderBy("created_at")
    .execute();

const typeRow = (trx: Kysely<DB>, id: string) =>
  trx
    .selectFrom("testbed_types")
    .select(["name", "duration_value", "duration_unit", "deleted_at"])
    .where("id", "=", id)
    .executeTakeFirstOrThrow();

afterAll(() => (hasDb ? db().destroy() : undefined));

describe.skipIf(!hasDb)("listTestbedTypes usage count", () => {
  it("counts only the live testbeds of each type", () =>
    inRollback(async (trx) => {
      const tag = unique();
      const used = await makeType(trx, { name: `used ${tag}` });
      const unused = await makeType(trx, { name: `unused ${tag}` });
      await makeTestbed(trx, used.id);
      await makeTestbed(trx, used.id);
      await makeTestbed(trx, used.id, { deleted_at: new Date() });
      await makeTestbed(trx, unused.id, { deleted_at: new Date() });

      const mine = (await listTestbedTypes(trx)).filter((t) =>
        t.name.endsWith(tag),
      );

      expect(mine.map((t) => [t.name, t.testbedCount])).toEqual([
        [`unused ${tag}`, 0],
        [`used ${tag}`, 2],
      ]);
    }));
});

describe.skipIf(!hasDb)("updateTestbedType", () => {
  it("saves the new values and audits only the changed fields", () =>
    inRollback(async (trx) => {
      const admin = await makeUser(trx, { role: "admin", company: null });
      const type = await makeType(trx, { name: `Basic ${unique()}` });
      const input = {
        name: type.name,
        durationValue: 4,
        durationUnit: "days",
      } as const;

      const result = await updateTestbedType(
        asConn(trx),
        type.id,
        input,
        admin.id,
      );

      expect(result).toEqual({ ok: true, value: { note: null } });
      expect(await typeRow(trx, type.id)).toMatchObject({
        duration_value: 4,
        duration_unit: "days",
      });
      expect(await auditsFor(trx, type.id)).toEqual([
        {
          action: "testbed_type.updated",
          actor_user_id: admin.id,
          metadata: {
            durationValue: { from: 2, to: 4 },
            durationUnit: { from: "hours", to: "days" },
          },
        },
      ]);
    }));

  it("writes no audit entry when nothing changed", () =>
    inRollback(async (trx) => {
      const admin = await makeUser(trx, { role: "admin", company: null });
      const type = await makeType(trx);

      const result = await updateTestbedType(
        asConn(trx),
        type.id,
        { name: type.name, durationValue: 2, durationUnit: "hours" },
        admin.id,
      );

      expect(result.ok).toBe(true);
      expect(await auditsFor(trx, type.id)).toEqual([]);
    }));

  it("refuses another live type's name ignoring case, leaving the row as it was", () =>
    inRollback(async (trx) => {
      const admin = await makeUser(trx, { role: "admin", company: null });
      const taken = await makeType(trx, { name: `Taken ${unique()}` });
      const type = await makeType(trx);

      const result = await updateTestbedType(
        asConn(trx),
        type.id,
        {
          name: taken.name.toUpperCase(),
          durationValue: 9,
          durationUnit: "days",
        },
        admin.id,
      );

      expect(result).toEqual({ ok: false, error: "duplicate_name" });
      expect(await typeRow(trx, type.id)).toMatchObject({
        name: type.name,
        duration_value: 2,
      });
      expect(await auditsFor(trx, type.id)).toEqual([]);
    }));

  it("allows a change of case to its own name, and a deleted type's name", () =>
    inRollback(async (trx) => {
      const admin = await makeUser(trx, { role: "admin", company: null });
      const type = await makeType(trx, { name: `Own ${unique()}` });
      const gone = await makeType(trx, {
        name: `Gone ${unique()}`,
        deleted_at: new Date(),
      });
      const edit = (name: string) =>
        updateTestbedType(
          asConn(trx),
          type.id,
          { name, durationValue: 2, durationUnit: "hours" },
          admin.id,
        );

      expect((await edit(type.name.toUpperCase())).ok).toBe(true);
      expect((await edit(gone.name)).ok).toBe(true);
      expect((await typeRow(trx, type.id)).name).toBe(gone.name);
    }));

  it("refuses a missing or deleted type as not found", () =>
    inRollback(async (trx) => {
      const admin = await makeUser(trx, { role: "admin", company: null });
      const deleted = await makeType(trx, { deleted_at: new Date() });
      const input = {
        name: `x ${unique()}`,
        durationValue: 1,
        durationUnit: "hours",
      } as const;

      for (const id of [crypto.randomUUID(), deleted.id])
        expect(
          await updateTestbedType(asConn(trx), id, input, admin.id),
        ).toEqual({ ok: false, error: "not_found" });
    }));

  it("keeps an existing booking's end when the duration changes", () =>
    inRollback(async (trx) => {
      const admin = await makeUser(trx, { role: "admin", company: null });
      const learner = await makeUser(trx);
      const type = await makeType(trx);
      const testbed = await makeTestbed(trx, type.id);
      const startsAt = slot(48);
      const endsAt = new Date(startsAt.getTime() + 2 * 3_600_000);
      const booking = await trx
        .insertInto("bookings")
        .values({
          user_id: learner.id,
          testbed_id: testbed.id,
          testbed_type_id: type.id,
          starts_at: startsAt,
          ends_at: endsAt,
          status: "confirmed",
        })
        .returning("id")
        .executeTakeFirstOrThrow();

      await updateTestbedType(
        asConn(trx),
        type.id,
        { name: type.name, durationValue: 5, durationUnit: "days" },
        admin.id,
      );

      const after = await trx
        .selectFrom("bookings")
        .select("ends_at")
        .where("id", "=", booking.id)
        .executeTakeFirstOrThrow();
      expect(after.ends_at).toEqual(endsAt);
    }));
});

describe.skipIf(!hasDb)("deleteTestbedType", () => {
  it("soft deletes an unused type, audits it, and frees its name", () =>
    inRollback(async (trx) => {
      const admin = await makeUser(trx, { role: "admin", company: null });
      const type = await makeType(trx);
      await makeTestbed(trx, type.id, { deleted_at: new Date() });

      const result = await deleteTestbedType(asConn(trx), type.id, admin.id);

      expect(result).toEqual({ ok: true, value: { note: null } });
      expect((await typeRow(trx, type.id)).deleted_at).not.toBeNull();
      expect(await auditsFor(trx, type.id)).toEqual([
        {
          action: "testbed_type.deleted",
          actor_user_id: admin.id,
          metadata: {},
        },
      ]);
      expect((await listTestbedTypes(trx)).some((t) => t.id === type.id)).toBe(
        false,
      );
      await expect(makeType(trx, { name: type.name })).resolves.toBeDefined();
    }));

  it("refuses while live testbeds use the type, listing them by name", () =>
    inRollback(async (trx) => {
      const admin = await makeUser(trx, { role: "admin", company: null });
      const type = await makeType(trx);
      const b = await makeTestbed(trx, type.id, { name: `b ${unique()}` });
      const a = await makeTestbed(trx, type.id, { name: `a ${unique()}` });

      const result = await deleteTestbedType(asConn(trx), type.id, admin.id);

      expect(result).toEqual({
        ok: false,
        error: {
          kind: "blocked",
          blockers: [
            { id: a.id, label: a.name },
            { id: b.id, label: b.name },
          ],
        },
      });
      expect((await typeRow(trx, type.id)).deleted_at).toBeNull();
      expect(await auditsFor(trx, type.id)).toEqual([]);
    }));

  it("refuses a missing or already deleted type as not found", () =>
    inRollback(async (trx) => {
      const admin = await makeUser(trx, { role: "admin", company: null });
      const deleted = await makeType(trx, { deleted_at: new Date() });

      for (const id of [crypto.randomUUID(), deleted.id])
        expect(await deleteTestbedType(asConn(trx), id, admin.id)).toEqual({
          ok: false,
          error: { kind: "not_found" },
        });
    }));

  it("keeps past bookings joined to the deleted type", () =>
    inRollback(async (trx) => {
      const admin = await makeUser(trx, { role: "admin", company: null });
      const learner = await makeUser(trx);
      const type = await makeType(trx);
      const testbed = await makeTestbed(trx, type.id);
      const startsAt = slot(-48);
      const booking = await trx
        .insertInto("bookings")
        .values({
          user_id: learner.id,
          testbed_id: testbed.id,
          testbed_type_id: type.id,
          starts_at: startsAt,
          ends_at: new Date(startsAt.getTime() + 2 * 3_600_000),
          status: "confirmed",
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await trx
        .updateTable("testbeds")
        .set({ deleted_at: new Date() })
        .where("id", "=", testbed.id)
        .execute();

      expect((await deleteTestbedType(asConn(trx), type.id, admin.id)).ok).toBe(
        true,
      );
      const joined = await trx
        .selectFrom("bookings")
        .innerJoin(
          "testbed_types",
          "testbed_types.id",
          "bookings.testbed_type_id",
        )
        .select("testbed_types.name")
        .where("bookings.id", "=", booking.id)
        .executeTakeFirstOrThrow();
      expect(joined.name).toBe(type.name);
    }));
});

// Spec 0026: the type's Authentik group, through the real transaction and the
// in memory Authentik. A refusal must leave the row and the audit as they were.
const groupOf = (trx: Kysely<DB>, id: string) =>
  trx
    .selectFrom("testbed_types")
    .select([
      "name",
      "authentik_group_pk",
      "authentik_group_origin",
      "deleted_at",
    ])
    .where("id", "=", id)
    .executeTakeFirstOrThrow();

const OWNER_UUID = "22222222-2222-4222-8222-222222222222";

const input = (name: string) =>
  ({ name, durationValue: 2, durationUnit: "hours" }) as const;

const typeCount = (trx: Kysely<DB>, name: string) =>
  trx
    .selectFrom("testbed_types")
    .select("id")
    .where("name", "=", name)
    .execute()
    .then((r) => r.length);

const quiet = () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
};

describe.skipIf(!hasDb)("createTestbedType with a group (spec 0026)", () => {
  it("makes the group, stores its pk, and audits it (AC-1)", () =>
    inRollback(async (trx) => {
      const admin = await makeUser(trx, { role: "admin" });
      const ak = fakeAuthentik([]);
      const name = `Group ${unique()}`;
      const r = await createTestbedType(
        asConn(trx),
        input(name),
        admin.id,
        ak.api,
      );
      if (!r.ok) throw new Error(r.error);
      const made = ak.groups.find((g) => g.name === name);
      expect(made?.attributes).toEqual({
        hol_type_group: true,
        hol_type_id: r.value.id,
      });
      expect(await groupOf(trx, r.value.id)).toMatchObject({
        authentik_group_pk: made?.pk,
        authentik_group_origin: "created",
      });
      expect((await auditsFor(trx, r.value.id)).map((a) => a.action)).toEqual([
        "testbed_type.created",
        "authentik_group.created",
      ]);
    }));

  it("links a plain same name group and changes nothing in Authentik (AC-2)", () =>
    inRollback(async (trx) => {
      const admin = await makeUser(trx, { role: "admin" });
      const name = `Owner ${unique()}`;
      const ak = fakeAuthentik([], { groups: [fakeGroup(OWNER_UUID, name)] });
      const r = await createTestbedType(
        asConn(trx),
        input(name),
        admin.id,
        ak.api,
      );
      if (!r.ok) throw new Error(r.error);
      expect(ak.writes).toEqual([]);
      expect(await groupOf(trx, r.value.id)).toMatchObject({
        authentik_group_pk: OWNER_UUID,
        authentik_group_origin: "reused",
      });
      expect((await auditsFor(trx, r.value.id)).map((a) => a.action)).toContain(
        "authentik_group.linked",
      );
    }));

  it("refuses an unsafe group, one already used, and an outage, saving nothing (AC-3, AC-4)", () =>
    inRollback(async (trx) => {
      quiet();
      const admin = await makeUser(trx, { role: "admin" });
      const tag = unique();
      const unsafe = `Unsafe ${tag}`;
      const ak = fakeAuthentik([], {
        groups: [markedGroup("tb-uuid", unsafe)],
      });
      expect(
        await createTestbedType(asConn(trx), input(unsafe), admin.id, ak.api),
      ).toEqual({ ok: false, error: "group_unusable" });
      expect(await typeCount(trx, unsafe)).toBe(0);

      const used = `Used ${tag}`;
      await makeType(trx, {
        name: `Holder ${tag}`,
        authentik_group_pk: "11111111-1111-4111-8111-111111111111",
        authentik_group_origin: "reused",
      });
      const ak2 = fakeAuthentik([], {
        groups: [fakeGroup("11111111-1111-4111-8111-111111111111", used)],
      });
      expect(
        await createTestbedType(asConn(trx), input(used), admin.id, ak2.api),
      ).toEqual({ ok: false, error: "group_in_use" });
      expect(await typeCount(trx, used)).toBe(0);

      const down = `Down ${tag}`;
      expect(
        await createTestbedType(
          asConn(trx),
          input(down),
          admin.id,
          fakeAuthentik([], { down: true }).api,
        ),
      ).toEqual({ ok: false, error: "unavailable" });
      expect(await typeCount(trx, down)).toBe(0);
      const left = await trx
        .selectFrom("audit_events")
        .select("id")
        .where("summary", "like", "Testbed type created")
        .where("actor_user_id", "=", admin.id)
        .execute();
      expect(left).toEqual([]);
    }));
});

describe.skipIf(!hasDb)("updateTestbedType with a group (spec 0026)", () => {
  it("renames the group the app made, and only for a name change (AC-5)", () =>
    inRollback(async (trx) => {
      const admin = await makeUser(trx, { role: "admin" });
      const tag = unique();
      const ak = fakeAuthentik([]);
      const created = await createTestbedType(
        asConn(trx),
        input(`Old ${tag}`),
        admin.id,
        ak.api,
      );
      if (!created.ok) throw new Error(created.error);
      const id = created.value.id;
      ak.writes.length = 0;

      await updateTestbedType(
        asConn(trx),
        id,
        { ...input(`Old ${tag}`), durationValue: 5 },
        admin.id,
        ak.api,
      );
      expect(ak.writes).toEqual([]);

      const r = await updateTestbedType(
        asConn(trx),
        id,
        input(`New ${tag}`),
        admin.id,
        ak.api,
      );
      expect(r).toEqual({ ok: true, value: { note: null } });
      expect(ak.writes).toHaveLength(1);
      expect(ak.groups.some((g) => g.name === `New ${tag}`)).toBe(true);
      expect((await auditsFor(trx, id)).map((a) => a.action)).toContain(
        "authentik_group.renamed",
      );
    }));

  it("keeps a reused group's name, and calls nothing for an unlinked type (AC-7)", () =>
    inRollback(async (trx) => {
      const admin = await makeUser(trx, { role: "admin" });
      const tag = unique();
      const ak = fakeAuthentik([], {
        groups: [fakeGroup("owner-uuid", `R ${tag}`)],
      });
      const reused = await makeType(trx, {
        name: `R ${tag}`,
        authentik_group_pk: "11111111-1111-4111-8111-111111111111",
        authentik_group_origin: "reused",
      });
      expect(
        await updateTestbedType(
          asConn(trx),
          reused.id,
          input(`R2 ${tag}`),
          admin.id,
          ak.api,
        ),
      ).toEqual({ ok: true, value: { note: "group_kept" } });
      const bare = await makeType(trx, { name: `B ${tag}` });
      expect(
        await updateTestbedType(
          asConn(trx),
          bare.id,
          input(`B2 ${tag}`),
          admin.id,
          ak.api,
        ),
      ).toEqual({ ok: true, value: { note: null } });
      expect(ak.writes).toEqual([]);
    }));

  it("refuses a taken name, a changed group, and an outage, saving nothing (AC-4, AC-6, AC-8)", () =>
    inRollback(async (trx) => {
      quiet();
      const admin = await makeUser(trx, { role: "admin" });
      const tag = unique();
      const ak = fakeAuthentik([], {
        groups: [fakeGroup("other", `Taken ${tag}`)],
      });
      const created = await createTestbedType(
        asConn(trx),
        input(`Mine ${tag}`),
        admin.id,
        ak.api,
      );
      if (!created.ok) throw new Error(created.error);
      const id = created.value.id;
      expect(
        await updateTestbedType(
          asConn(trx),
          id,
          input(`Taken ${tag}`),
          admin.id,
          ak.api,
        ),
      ).toEqual({ ok: false, error: "group_clash" });
      expect((await groupOf(trx, id)).name).toBe(`Mine ${tag}`);

      const group = ak.groups.find((g) => g.name === `Mine ${tag}`);
      if (group) group.attributes = {};
      expect(
        await updateTestbedType(
          asConn(trx),
          id,
          input(`Next ${tag}`),
          admin.id,
          ak.api,
        ),
      ).toEqual({ ok: false, error: "group_changed" });
      expect((await groupOf(trx, id)).name).toBe(`Mine ${tag}`);

      const down = fakeAuthentik([], { down: true });
      expect(
        await updateTestbedType(
          asConn(trx),
          id,
          input(`Down ${tag}`),
          admin.id,
          down.api,
        ),
      ).toEqual({ ok: false, error: "unavailable" });
      expect((await groupOf(trx, id)).name).toBe(`Mine ${tag}`);
    }));
});

describe.skipIf(!hasDb)("deleteTestbedType with a group (spec 0026)", () => {
  it("deletes the group the app made and audits the member count (AC-9)", () =>
    inRollback(async (trx) => {
      const admin = await makeUser(trx, { role: "admin" });
      const ak = fakeAuthentik([]);
      const created = await createTestbedType(
        asConn(trx),
        input(`Del ${unique()}`),
        admin.id,
        ak.api,
      );
      if (!created.ok) throw new Error(created.error);
      const id = created.value.id;
      const pk = (await groupOf(trx, id)).authentik_group_pk;
      expect(
        await deleteTestbedType(asConn(trx), id, admin.id, ak.api),
      ).toEqual({
        ok: true,
        value: { note: null },
      });
      expect(ak.groups.some((g) => g.pk === pk)).toBe(false);
      const deleted = (await auditsFor(trx, id)).find(
        (a) => a.action === "authentik_group.deleted",
      );
      expect(deleted?.metadata).toEqual({ groupPk: pk, memberCount: 0 });
    }));

  it("leaves a bound group, a reused one, and refuses on an outage (AC-4, AC-10)", () =>
    inRollback(async (trx) => {
      quiet();
      const admin = await makeUser(trx, { role: "admin" });
      const ak = fakeAuthentik([]);
      const created = await createTestbedType(
        asConn(trx),
        input(`Bound ${unique()}`),
        admin.id,
        ak.api,
      );
      if (!created.ok) throw new Error(created.error);
      const id = created.value.id;
      const pk = (await groupOf(trx, id)).authentik_group_pk ?? "";

      const down = fakeAuthentik([], { down: true });
      expect(
        await deleteTestbedType(asConn(trx), id, admin.id, down.api),
      ).toEqual({
        ok: false,
        error: { kind: "unavailable" },
      });
      expect((await groupOf(trx, id)).deleted_at).toBeNull();

      const bound = fakeAuthentik([], {
        groups: [fakeGroup(pk, "x", { hol_type_group: true, hol_type_id: id })],
        usedBy: [pk],
      });
      expect(
        await deleteTestbedType(asConn(trx), id, admin.id, bound.api),
      ).toEqual({
        ok: true,
        value: { note: "group_left" },
      });
      expect(bound.writes).toEqual([]);
      const row = (await auditsFor(trx, id)).find(
        (a) => a.action === "testbed_type.deleted",
      );
      expect(row?.metadata).toEqual({ groupLeft: true, reason: "bound" });

      const reused = await makeType(trx, {
        name: `Re ${unique()}`,
        authentik_group_pk: "11111111-1111-4111-8111-111111111111",
        authentik_group_origin: "reused",
      });
      const ak2 = fakeAuthentik([]);
      expect(
        await deleteTestbedType(asConn(trx), reused.id, admin.id, ak2.api),
      ).toEqual({
        ok: true,
        value: { note: null },
      });
      expect(ak2.writes).toEqual([]);
    }));
});

// Spec 0026 AC-19: a type edit never holds a booking up for an Authentik call.
// A booking takes the type row FOR SHARE, so the test records, in order, every
// Authentik request, the advisory lock, and every row lock (a SELECT ... FOR
// UPDATE) the edit takes, and checks where the row lock falls.
type Event = "advisory" | "row_lock" | "authentik";

function traced(trx: Transaction<DB>) {
  const events: Event[] = [];
  const plugin: KyselyPlugin = {
    transformQuery: ({ node }) => {
      if (
        node.kind === "SelectQueryNode" &&
        (node as SelectQueryNode).endModifiers?.some(
          (m) => m.modifier === "ForUpdate",
        )
      )
        events.push("row_lock");
      if (
        node.kind === "RawNode" &&
        (node as RawNode).sqlFragments
          .join("")
          .includes("pg_advisory_xact_lock")
      )
        events.push("advisory");
      return node;
    },
    transformResult: async ({ result }) => result,
  };
  return {
    events,
    conn: asConn(trx.withPlugin(plugin)),
    onRequest: () => events.push("authentik"),
  };
}

describe.skipIf(!hasDb)("type edit locks (spec 0026 AC-19)", () => {
  it("takes the advisory lock first and the row lock only after every rename call", () =>
    inRollback(async (trx) => {
      const admin = await makeUser(trx, { role: "admin" });
      const tag = unique();
      const seed = fakeAuthentik([]);
      const created = await createTestbedType(
        asConn(trx),
        input(`Old ${tag}`),
        admin.id,
        seed.api,
      );
      if (!created.ok) throw new Error(created.error);

      const t = traced(trx);
      const ak = fakeAuthentik([], {
        groups: seed.groups.filter((g) => g.name === `Old ${tag}`),
        onRequest: t.onRequest,
      });
      const r = await updateTestbedType(
        t.conn,
        created.value.id,
        input(`New ${tag}`),
        admin.id,
        ak.api,
      );
      expect(r.ok).toBe(true);
      expect(ak.writes).toHaveLength(1);
      expect(t.events[0]).toBe("advisory");
      const lastCall = t.events.lastIndexOf("authentik");
      expect(lastCall).toBeGreaterThan(0);
      expect(t.events.indexOf("row_lock")).toBeGreaterThan(lastCall);
    }));

  it("makes no Authentik call under the row lock when the rename fails", () =>
    inRollback(async (trx) => {
      const admin = await makeUser(trx, { role: "admin" });
      const tag = unique();
      const created = await createTestbedType(
        asConn(trx),
        input(`Old ${tag}`),
        admin.id,
        fakeAuthentik([]).api,
      );
      if (!created.ok) throw new Error(created.error);
      quiet();
      const t = traced(trx);
      const down = fakeAuthentik([], { down: true, onRequest: t.onRequest });
      const r = await updateTestbedType(
        t.conn,
        created.value.id,
        input(`New ${tag}`),
        admin.id,
        down.api,
      );
      expect(r).toEqual({ ok: false, error: "unavailable" });
      expect(t.events).not.toContain("row_lock");
      expect((await typeRow(trx, created.value.id)).name).toBe(`Old ${tag}`);
    }));

  it("refuses a duplicate name before it renames the group", () =>
    inRollback(async (trx) => {
      const admin = await makeUser(trx, { role: "admin" });
      const tag = unique();
      const seed = fakeAuthentik([]);
      const a = await createTestbedType(
        asConn(trx),
        input(`A ${tag}`),
        admin.id,
        seed.api,
      );
      const b = await createTestbedType(
        asConn(trx),
        input(`B ${tag}`),
        admin.id,
        seed.api,
      );
      if (!a.ok || !b.ok) throw new Error("setup");
      seed.writes.length = 0;
      const r = await updateTestbedType(
        asConn(trx),
        a.value.id,
        input(`b ${tag}`),
        admin.id,
        seed.api,
      );
      expect(r).toEqual({ ok: false, error: "duplicate_name" });
      expect(seed.writes).toEqual([]);
    }));

  it("reads and decides before the row lock on a delete, leaving only the last read and the destroy under it", () =>
    inRollback(async (trx) => {
      const admin = await makeUser(trx, { role: "admin" });
      const created = await createTestbedType(
        asConn(trx),
        input(`Del ${unique()}`),
        admin.id,
        fakeAuthentik([]).api,
      );
      if (!created.ok) throw new Error(created.error);
      const pk = (await groupOf(trx, created.value.id)).authentik_group_pk;
      const t = traced(trx);
      const ak = fakeAuthentik([], {
        groups: [
          fakeGroup(pk ?? "x", "Del", {
            hol_type_group: true,
            hol_type_id: created.value.id,
          }),
        ],
        onRequest: t.onRequest,
      });
      const r = await deleteTestbedType(
        t.conn,
        created.value.id,
        admin.id,
        ak.api,
      );
      expect(r.ok).toBe(true);
      expect(ak.writes).toHaveLength(1);
      expect(t.events[0]).toBe("advisory");
      const firstRowLock = t.events.indexOf("row_lock");
      // The reads (admin group, retrieve, bindings, members) come before it;
      // the last read and the destroy come after it, and nothing else.
      expect(t.events.slice(firstRowLock + 1)).toEqual([
        "authentik",
        "authentik",
      ]);
    }));

  it("makes no Authentik call for a delete of a type with no group", () =>
    inRollback(async (trx) => {
      const admin = await makeUser(trx, { role: "admin" });
      const type = await makeType(trx);
      const t = traced(trx);
      const ak = fakeAuthentik([], { onRequest: t.onRequest });
      const r = await deleteTestbedType(t.conn, type.id, admin.id, ak.api);
      expect(r.ok).toBe(true);
      expect(t.events).toEqual(["advisory", "row_lock"]);
    }));
});
