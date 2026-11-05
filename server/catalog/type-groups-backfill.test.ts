import { afterAll, describe, expect, it, vi } from "vitest";
import {
  fakeAuthentik,
  fakeGroup,
  markedGroup,
} from "@/server/authentik/testing";
import { db } from "@/server/db";
import { asConn, hasDb, inRollback, makeType } from "@/server/db/testing";
import {
  backfillTypeGroups,
  type BackfillReport,
} from "./type-groups-backfill";

afterAll(() => (hasDb ? db().destroy() : undefined));

const unique = () => crypto.randomUUID().slice(0, 8);
const OWNER = "33333333-3333-4333-8333-333333333333";

// The shared database may hold real unlinked types, so each test looks at its
// own rows only.
const only = (r: BackfillReport, ids: readonly string[]) =>
  r.lines.filter((l) => ids.includes(l.typeId));

// covers: spec 0026 AC-14, AC-15
describe.skipIf(!hasDb)("backfillTypeGroups (spec 0026)", () => {
  it("plans in a dry run, applies per type, and a second run changes nothing", () =>
    inRollback(async (trx) => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const tag = unique();
      const fresh = await makeType(trx, { name: `Fresh ${tag}` });
      const owned = await makeType(trx, { name: `Owned ${tag}` });
      const unsafe = await makeType(trx, { name: `Unsafe ${tag}` });
      const ids = [fresh.id, owned.id, unsafe.id];
      const ak = fakeAuthentik([], {
        groups: [
          fakeGroup(OWNER, `Owned ${tag}`),
          markedGroup("tb-uuid", `Unsafe ${tag}`),
        ],
      });

      const plan = await backfillTypeGroups(asConn(trx), ak.api, false);
      expect(ak.writes).toEqual([]);
      expect(only(plan, ids).map((l) => [l.name, l.result, l.reason])).toEqual([
        [`Fresh ${tag}`, "created", undefined],
        [`Owned ${tag}`, "linked", undefined],
        [`Unsafe ${tag}`, "skipped", "unsafe"],
      ]);

      const applied = await backfillTypeGroups(asConn(trx), ak.api, true);
      expect(applied.stopped).toBe(false);
      expect(only(applied, ids).map((l) => l.result)).toEqual([
        "created",
        "linked",
        "skipped",
      ]);
      const rows = await trx
        .selectFrom("testbed_types")
        .select(["id", "authentik_group_pk", "authentik_group_origin"])
        .where("id", "in", ids)
        .execute();
      const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
      expect(byId[fresh.id]?.authentik_group_origin).toBe("created");
      expect(byId[owned.id]).toMatchObject({
        authentik_group_pk: OWNER,
        authentik_group_origin: "reused",
      });
      expect(byId[unsafe.id]?.authentik_group_pk).toBeNull();
      const audits = await trx
        .selectFrom("audit_events")
        .select(["action", "actor_user_id"])
        .where("target_id", "in", ids)
        .execute();
      expect(audits.every((a) => a.actor_user_id === null)).toBe(true);

      // A second run: the linked types are not touched, the unsafe one is
      // reported again, and nothing is written for them.
      ak.writes.length = 0;
      const again = await backfillTypeGroups(asConn(trx), ak.api, true);
      expect(only(again, ids).map((l) => l.typeId)).toEqual([unsafe.id]);
      expect(
        ak.writes.filter((w) => w.includes(fresh.id) || w.includes(OWNER)),
      ).toEqual([]);
    }));

  it("stops, and reports it, when Authentik cannot be reached", () =>
    inRollback(async (trx) => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const t = await makeType(trx, { name: `Down ${unique()}` });
      for (const apply of [false, true]) {
        const r = await backfillTypeGroups(
          asConn(trx),
          fakeAuthentik([], { down: true }).api,
          apply,
        );
        expect(r.stopped).toBe(true);
        expect(only(r, [t.id])).toEqual([]);
      }
      const row = await trx
        .selectFrom("testbed_types")
        .select("authentik_group_pk")
        .where("id", "=", t.id)
        .executeTakeFirstOrThrow();
      expect(row.authentik_group_pk).toBeNull();
    }));
});
