import { sql, type Kysely } from "kysely";
import { afterAll, describe, expect, it } from "vitest";
import type { TestbedInput } from "@/lib/catalog-input";
import { fakeAuthentik, fakeGroup } from "@/server/authentik/testing";
import { db } from "@/server/db";
import {
  asConn,
  hasDb,
  inRollback,
  makeTestbed,
  makeType,
  makeUser,
} from "@/server/db/testing";
import type { DB } from "@/server/db/types";
import { createTestbed, listTestbeds, undoTestbedCreate } from "./testbeds";
import { createTestbedType } from "./testbed-types";

const unique = () => crypto.randomUUID().slice(0, 8);

async function setup(trx: Kysely<DB>) {
  const admin = await makeUser(trx, { role: "admin", company: null });
  const type = await makeType(trx);
  const name = `Lab ${unique()}`;
  const input: TestbedInput = {
    name,
    testbedTypeId: type.id,
    portalUrl: "https://portal.example.test",
    lmsUrl: "https://lms.example.test",
    clients: [
      { kind: "wired", name: "Wired 1", url: "https://w1.example.test" },
      { kind: "wireless", name: "Air 1", url: "https://a1.example.test" },
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
});

// covers: AC-2, AC-11 (the undo the sweeper shares)
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
      const clients = await trx
        .selectFrom("testbed_clients")
        .select(["kind", "name", "position"])
        .where("testbed_id", "=", r.value.id)
        .orderBy("position")
        .execute();
      expect(clients).toEqual([
        { kind: "wired", name: "Wired 1", position: 0 },
        { kind: "wireless", name: "Air 1", position: 1 },
      ]);
      expect(await audits(r.value.id)).toEqual([{ action: "testbed.created" }]);
      expect(await audits(group?.pk ?? "")).toEqual([
        { action: "authentik_group.created" },
      ]);
      const listed = await listTestbeds(trx);
      expect(listed.find((t) => t.id === r.value.id)?.groupReady).toBe(true);
    }));

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
