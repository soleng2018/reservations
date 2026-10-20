import { sql, type Kysely } from "kysely";
import { afterAll, describe, expect, it } from "vitest";
import {
  ActorKind,
  auditHref,
  decodeCursor,
  parseAuditQuery,
  type AuditQuery,
} from "@/lib/audit-log";
import type { AuditTargetType } from "@/lib/db-enums";
import { db } from "@/server/db";
import {
  hasDb,
  inRollback,
  makeTestbed,
  makeType,
  makeUser,
} from "@/server/db/testing";
import type { DB } from "@/server/db/types";
import {
  listAdmins,
  listAuditEvents,
  resolveTargets,
  targetKey,
} from "./audit-log";

// Spec 0016: the read side. Every test seeds its own rows inside a rolled
// back transaction, at a far future time, so they page ahead of the shared
// database's real entries (and of any row the worker commits meanwhile).

afterAll(() => (hasDb ? db().destroy() : undefined));

const FUTURE = new Date("2100-01-01T00:00:00Z");

type Seed = {
  readonly actorUserId?: string | null;
  readonly action?: string;
  readonly targetType?: AuditTargetType;
  readonly targetId?: string;
  readonly summary?: string;
  readonly metadata?: Record<string, unknown>;
  readonly at?: Date;
};

// An entry inserted as audit() would write it, at a chosen time.
const entry = async (trx: Kysely<DB>, e: Seed = {}) =>
  trx
    .insertInto("audit_events")
    .values({
      actor_user_id: e.actorUserId ?? null,
      action: e.action ?? "testbed_type.updated",
      target_type: e.targetType ?? "testbed_type",
      target_id: e.targetId ?? crypto.randomUUID(),
      summary: e.summary ?? "Seeded entry",
      metadata: JSON.stringify(e.metadata ?? {}),
      created_at: e.at ?? FUTURE,
    })
    .returning("id")
    .executeTakeFirstOrThrow();

describe.skipIf(!hasDb)("listAuditEvents", () => {
  // covers: AC-2, AC-6, AC-7, the newest entry first with its names
  it("shows the newest entry first with actor, action, and target", () =>
    inRollback(async (trx) => {
      const admin = await makeUser(trx, {
        role: "admin",
        name: "Ada Admin",
        company: null,
      });
      const type = await makeType(trx, { name: "Basic audit" });
      await entry(trx, {
        actorUserId: admin.id,
        action: "testbed_type.updated",
        targetId: type.id,
        summary: "Testbed type updated",
        metadata: { durationValue: { from: 2, to: 3 } },
      });

      const page = await listAuditEvents(trx, {}, "UTC");
      const top = page.rows[0];

      expect(top.actor).toEqual({
        kind: "admin",
        label: "Ada Admin",
        userId: admin.id,
        role: "admin",
      });
      expect(top.action).toEqual({
        name: "testbed_type.updated",
        label: "Testbed type updated",
        area: "Testbed types",
      });
      expect(top.target).toEqual({
        type: "testbed_type",
        id: type.id,
        label: "Basic audit",
        deleted: false,
        href: `/admin/audit-log?target=testbed_type%3A${type.id}`,
      });
      expect(top.summary).toBe("Testbed type updated");
      // covers: AC-8, the row carries its readable details
      expect(top.details).toEqual([{ label: "Duration value", text: "2 → 3" }]);
    }));

  // covers: AC-6, a null actor reads by its action
  it("names a null actor Booking form or System by the action", () =>
    inRollback(async (trx) => {
      await entry(trx, { action: "access.granted", targetType: "booking" });
      await entry(trx, {
        action: "booking.created",
        targetType: "booking",
        at: new Date(FUTURE.getTime() + 1000),
      });

      const [booked, granted] = (await listAuditEvents(trx, {}, "UTC")).rows;

      expect(booked.actor).toEqual({
        kind: "booking_form",
        label: "Booking form",
      });
      expect(granted.actor).toEqual({ kind: "system", label: "System" });
    }));
});

describe.skipIf(!hasDb)("resolveTargets", () => {
  // covers: AC-7, every target kind and its fallbacks
  it("labels each target kind, with Deleted and not found fallbacks", () =>
    inRollback(async (trx) => {
      const learner = await makeUser(trx, {
        name: "Lea Learner",
        email: `lea-${crypto.randomUUID().slice(0, 6)}@example.test`,
      });
      const admin = await makeUser(trx, { role: "admin", name: "Ann" });
      const type = await makeType(trx, {
        name: "Gone type",
        deleted_at: new Date(),
      });
      const testbed = await makeTestbed(trx, type.id, {
        name: "Pod 7",
        deleted_at: new Date(),
      });
      const booking = await trx
        .insertInto("bookings")
        .values({
          user_id: learner.id,
          testbed_id: testbed.id,
          testbed_type_id: type.id,
          starts_at: new Date("2026-10-13T13:00:00Z"),
          ends_at: new Date("2026-10-13T15:00:00Z"),
          status: "completed",
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      const missing = crypto.randomUUID();
      const refs = [
        { type: "testbed_type", id: type.id },
        { type: "testbed", id: testbed.id },
        { type: "user", id: learner.id },
        { type: "user", id: admin.id },
        { type: "user", id: "authentik:12" },
        { type: "user", id: "unknown" },
        { type: "booking", id: booking.id },
        { type: "booking", id: testbed.id },
        { type: "api_key", id: missing },
        { type: "api_key", id: "not-a-uuid" },
        { type: "authentik_group", id: testbed.authentik_group_pk ?? "" },
        {
          type: "authentik_group",
          id: "undone-1",
          metadata: { name: "pod-undone" },
        },
        { type: "authentik_group", id: "undone-2" },
      ];

      const labels = await resolveTargets(trx, refs, "America/New_York");
      const label = (type: string, id: string) =>
        labels.get(targetKey(type, id));

      expect(label("testbed_type", type.id)).toEqual({
        label: "Gone type",
        deleted: true,
        found: true,
      });
      expect(label("testbed", testbed.id)?.deleted).toBe(true);
      expect(label("user", learner.id)?.label).toBe(
        `Lea Learner · ${learner.email}`,
      );
      expect(label("user", admin.id)?.label).toBe(
        `Ann · ${admin.email} (admin)`,
      );
      expect(label("user", "authentik:12")?.label).toBe("Authentik user 12");
      expect(label("user", "unknown")?.label).toBe("Unknown");
      expect(label("booking", booking.id)?.label).toBe(
        "Lea Learner · Pod 7 (deleted testbed) · Tue, Oct 13, 2026, 9:00 AM EDT",
      );
      expect(label("booking", testbed.id)).toEqual({
        label: "Booking (not found)",
        deleted: false,
        found: false,
      });
      expect(label("api_key", missing)?.label).toBe("API key (not found)");
      expect(label("api_key", "not-a-uuid")?.label).toBe("API key (not found)");
      expect(
        label("authentik_group", testbed.authentik_group_pk ?? "")?.label,
      ).toBe("Pod 7 access group");
      expect(label("authentik_group", "undone-1")?.label).toBe(
        "pod-undone access group",
      );
      expect(label("authentik_group", "undone-2")?.label).toBe(
        "Access group (not found)",
      );
    }));
});

// A walk through every page in one direction, from a starting query.
async function walk(
  trx: Kysely<DB>,
  base: AuditQuery,
  dir: "older" | "newer",
  start: AuditQuery = base,
): Promise<{ ids: string[]; pages: number; last: AuditQuery }> {
  const seen: string[] = [];
  let query = start;
  let pages = 0;
  for (;;) {
    const page = await listAuditEvents(trx, query, "UTC");
    pages += 1;
    seen.push(...page.rows.map((r) => r.id));
    const next = dir === "older" ? page.older : page.newer;
    if (!next || pages > 10) return { ids: seen, pages, last: query };
    query = parseAuditQuery(
      Object.fromEntries(
        new URL(
          auditHref(base, dir === "older" ? { before: next } : { after: next }),
          "http://x",
        ).searchParams,
      ),
    ).query;
  }
}

describe.skipIf(!hasDb)("listAuditEvents paging", () => {
  // covers: AC-3, ties broken by id: every entry once, both ways
  it("walks 120 entries written at one instant, Older then Newer", () =>
    inRollback(async (trx) => {
      const targetId = crypto.randomUUID();
      const ids = await Promise.all(
        Array.from({ length: 120 }, () => entry(trx, { targetId })),
      ).then((rows) => rows.map((r) => r.id));
      const base: AuditQuery = {
        target: { type: "testbed_type", id: targetId },
      };

      const first = await listAuditEvents(trx, base, "UTC");
      expect(first.rows).toHaveLength(50);
      expect(first.newer).toBeUndefined();
      expect(first.older).toBeDefined();

      const down = await walk(trx, base, "older");
      expect(down.pages).toBe(3);
      expect(new Set(down.ids).size).toBe(120);
      expect([...down.ids].sort()).toEqual([...ids].sort());
      // Ties read by id, newest (largest) first.
      expect(down.ids).toEqual([...ids].sort().reverse());

      // From the oldest page, Newer walks back up to the newest one.
      const up = await walk(trx, base, "newer", down.last);
      expect(new Set(up.ids).size).toBe(120);
      expect(up.pages).toBe(3);
      const top = await listAuditEvents(trx, up.last, "UTC");
      expect(top.newer).toBeUndefined();
      expect(top.rows.map((r) => r.id)).toEqual(first.rows.map((r) => r.id));
    }));

  // covers: AC-3, link rules on before and after pages
  it("shows Newer on a before page and Older on an after page", () =>
    inRollback(async (trx) => {
      const targetId = crypto.randomUUID();
      await Promise.all(
        Array.from({ length: 3 }, (_, i) =>
          entry(trx, { targetId, at: new Date(FUTURE.getTime() + i) }),
        ),
      );
      const base: AuditQuery = {
        target: { type: "testbed_type", id: targetId },
      };
      const all = await listAuditEvents(trx, base, "UTC");
      expect(all.rows).toHaveLength(3);
      expect(all.older ?? all.newer).toBeUndefined();

      const mid = decodeCursor(all.rows[1].cursor);
      if (!mid) throw new Error("cursor did not decode");
      const before = await listAuditEvents(
        trx,
        { ...base, cursor: { dir: "before", ...mid } },
        "UTC",
      );
      expect(before.rows.map((r) => r.id)).toEqual([all.rows[2].id]);
      expect(before.newer).toBe(all.rows[2].cursor);
      expect(before.older).toBeUndefined();

      const after = await listAuditEvents(
        trx,
        { ...base, cursor: { dir: "after", ...mid } },
        "UTC",
      );
      expect(after.rows.map((r) => r.id)).toEqual([all.rows[0].id]);
      expect(after.older).toBe(all.rows[0].cursor);
      expect(after.newer).toBeUndefined();

      // An empty page past a cursor still links back across it.
      const last = decodeCursor(all.rows[2].cursor);
      if (!last) throw new Error("cursor did not decode");
      const empty = await listAuditEvents(
        trx,
        { ...base, cursor: { dir: "before", ...last } },
        "UTC",
      );
      expect(empty.rows).toEqual([]);
      expect(empty.newer).toBe(all.rows[2].cursor);
    }));

  // covers: AC-3, the cursor keeps microseconds a JS Date would lose
  it("separates entries a microsecond apart", () =>
    inRollback(async (trx) => {
      const targetId = crypto.randomUUID();
      const insertAt = (us: string) =>
        trx
          .insertInto("audit_events")
          .values({
            action: "testbed_type.updated",
            target_type: "testbed_type",
            target_id: targetId,
            summary: "µs",
            created_at: sql<Date>`${`2100-01-01T00:00:00.000${us}Z`}::timestamptz`,
          })
          .returning("id")
          .executeTakeFirstOrThrow();
      const a = await insertAt("001");
      const b = await insertAt("002");
      const base: AuditQuery = {
        target: { type: "testbed_type", id: targetId },
      };
      const [newest] = (await listAuditEvents(trx, base, "UTC")).rows;
      expect(newest.id).toBe(b.id);
      const at = decodeCursor(newest.cursor);
      expect(at?.ts).toBe("2100-01-01T00:00:00.000002Z");
      if (!at) throw new Error("cursor did not decode");
      const older = await listAuditEvents(
        trx,
        { ...base, cursor: { dir: "before", ...at } },
        "UTC",
      );
      expect(older.rows.map((r) => r.id)).toEqual([a.id]);
    }));
});

describe.skipIf(!hasDb)("listAuditEvents filters", () => {
  const ids = async (trx: Kysely<DB>, query: AuditQuery, tz = "UTC") =>
    (await listAuditEvents(trx, query, tz)).rows.map((r) => r.id).sort();

  // covers: AC-4, AC-6, the actor filter returns what the display labels
  it("filters by actor kind, matching the display", () =>
    inRollback(async (trx) => {
      const tag = crypto.randomUUID().slice(0, 8);
      const admin = await makeUser(trx, { role: "admin" });
      const learner = await makeUser(trx);
      const summary = `actor ${tag}`;
      const rows = {
        admin: await entry(trx, { actorUserId: admin.id, summary }),
        learner: await entry(trx, { actorUserId: learner.id, summary }),
        booking_form: await entry(trx, { action: "booking.created", summary }),
        system: await entry(trx, { action: "access.revoked", summary }),
        legacy: await entry(trx, { action: "pod.flushed", summary }),
      };
      for (const kind of ActorKind.options) {
        const page = await listAuditEvents(trx, { q: tag, actor: kind }, "UTC");
        expect(page.rows.every((r) => r.actor.kind === kind)).toBe(true);
        const want =
          kind === "system"
            ? [rows.system.id, rows.legacy.id]
            : [rows[kind].id];
        expect(page.rows.map((r) => r.id).sort()).toEqual(want.sort());
      }
    }));

  // covers: AC-4, area and admin, alone and together (AND)
  it("filters by area and by admin, and combines them", () =>
    inRollback(async (trx) => {
      const tag = crypto.randomUUID().slice(0, 8);
      const ann = await makeUser(trx, { role: "admin" });
      const bob = await makeUser(trx, { role: "admin" });
      const summary = `area ${tag}`;
      const annType = await entry(trx, { actorUserId: ann.id, summary });
      const annKey = await entry(trx, {
        actorUserId: ann.id,
        action: "api_key.created",
        targetType: "api_key",
        summary,
      });
      const bobType = await entry(trx, { actorUserId: bob.id, summary });

      expect(await ids(trx, { q: tag, area: "testbed_types" })).toEqual(
        [annType.id, bobType.id].sort(),
      );
      expect(await ids(trx, { q: tag, admin: ann.id })).toEqual(
        [annType.id, annKey.id].sort(),
      );
      expect(
        await ids(trx, { q: tag, admin: ann.id, area: "api_keys" }),
      ).toEqual([annKey.id]);
      expect(
        (await listAdmins(trx)).filter((a) => [ann.id, bob.id].includes(a.id)),
      ).toHaveLength(2);
    }));

  // covers: AC-4, whole days in the admin's zone, around midnight
  it("reads from and to as whole days in the admin's zone", () =>
    inRollback(async (trx) => {
      const tag = crypto.randomUUID().slice(0, 8);
      const summary = `day ${tag}`;
      // 2099-07-04 in Los Angeles (PDT, UTC-7) is 07:00Z to 07:00Z next day.
      const at = (iso: string) => entry(trx, { summary, at: new Date(iso) });
      const lateJuly3 = await at("2099-07-04T06:59:59Z");
      const earlyJuly4 = await at("2099-07-04T07:00:00Z");
      const lateJuly4 = await at("2099-07-05T06:59:59Z");
      const earlyJuly5 = await at("2099-07-05T07:00:00Z");
      const la = "America/Los_Angeles";

      expect(
        await ids(trx, { q: tag, from: "2099-07-04", to: "2099-07-04" }, la),
      ).toEqual([earlyJuly4.id, lateJuly4.id].sort());
      expect(await ids(trx, { q: tag, from: "2099-07-05" }, la)).toEqual([
        earlyJuly5.id,
      ]);
      expect(await ids(trx, { q: tag, to: "2099-07-03" }, la)).toEqual([
        lateJuly3.id,
      ]);
      // The same dates in UTC split the rows differently.
      expect(
        await ids(trx, { q: tag, from: "2099-07-04", to: "2099-07-04" }),
      ).toEqual([earlyJuly4.id, lateJuly3.id].sort());
    }));

  // covers: AC-4 q, each place free text looks
  it("matches q against summary, action, actor, and target names", () =>
    inRollback(async (trx) => {
      const tag = crypto.randomUUID().slice(0, 8);
      const actor = await makeUser(trx, {
        role: "admin",
        name: `Grace ${tag}`,
        email: `grace-${tag}@example.test`,
      });
      const learner = await makeUser(trx, { name: `Lin ${tag}` });
      const type = await makeType(trx, { name: `Type ${tag}` });
      const testbed = await makeTestbed(trx, type.id, { name: `Pod ${tag}` });
      const booking = await trx
        .insertInto("bookings")
        .values({
          user_id: learner.id,
          testbed_id: testbed.id,
          testbed_type_id: type.id,
          starts_at: new Date("2099-01-01T10:00:00Z"),
          ends_at: new Date("2099-01-01T12:00:00Z"),
          status: "completed",
        })
        .returning("id")
        .executeTakeFirstOrThrow();

      const bySummary = await entry(trx, { summary: `note ${tag} 50%_off` });
      const byActor = await entry(trx, { actorUserId: actor.id });
      const byType = await entry(trx, { targetId: type.id });
      const byBooking = await entry(trx, {
        action: "booking.created",
        targetType: "booking",
        targetId: booking.id,
      });
      const byUser = await entry(trx, {
        action: "user.updated",
        targetType: "user",
        targetId: learner.id,
      });
      const byGroup = await entry(trx, {
        action: "authentik_group.created",
        targetType: "authentik_group",
        targetId: testbed.authentik_group_pk ?? "",
      });

      expect(await ids(trx, { q: tag })).toEqual(
        [
          bySummary.id,
          byActor.id,
          byType.id,
          byBooking.id,
          byUser.id,
          byGroup.id,
        ].sort(),
      );
      expect(await ids(trx, { q: `grace-${tag}@` })).toEqual([byActor.id]);
      // Wildcards are literal: "%_" matches only the summary holding them.
      const wild = await listAuditEvents(trx, { q: `${tag} 50%_` }, "UTC");
      expect(wild.rows.map((r) => r.id)).toEqual([bySummary.id]);
      const none = await listAuditEvents(trx, { q: `${tag} 50__` }, "UTC");
      expect(none.rows).toEqual([]);
    }));

  it("matches q against an action's name and its label", () =>
    inRollback(async (trx) => {
      const row = await entry(trx, {
        action: "api_key.secret_replaced",
        targetType: "api_key",
        summary: "no words here",
      });
      const top = async (q: string) =>
        (await listAuditEvents(trx, { q }, "UTC")).rows[0]?.id;
      expect(await top("secret replaced")).toBe(row.id);
      expect(await top("api_key.secret")).toBe(row.id);
    }));

  // covers: AC-5, the target filter is exact
  it("filters by one target", () =>
    inRollback(async (trx) => {
      const id = crypto.randomUUID();
      const mine = await entry(trx, { targetType: "testbed", targetId: id });
      await entry(trx, { targetType: "testbed_type", targetId: id });
      expect(await ids(trx, { target: { type: "testbed", id } })).toEqual([
        mine.id,
      ]);
    }));
});

describe.skipIf(!hasDb)("listAuditEvents learner history", () => {
  // covers: AC-5, the three arms, each row once, nobody else's
  it("shows a learner's grants, revokes, own changes, and admin edits once", () =>
    inRollback(async (trx) => {
      const admin = await makeUser(trx, { role: "admin" });
      const learner = await makeUser(trx);
      const other = await makeUser(trx);
      const type = await makeType(trx);
      const testbed = await makeTestbed(trx, type.id);
      const book = (userId: string) =>
        trx
          .insertInto("bookings")
          .values({
            user_id: userId,
            testbed_id: testbed.id,
            testbed_type_id: type.id,
            starts_at: new Date("2099-01-01T10:00:00Z"),
            ends_at: new Date("2099-01-01T12:00:00Z"),
            status: "completed",
          })
          .returning("id")
          .executeTakeFirstOrThrow();
      const mine = await book(learner.id);
      const theirs = await book(other.id);
      const t = (s: number) => new Date(FUTURE.getTime() + s * 1000);

      const granted = await entry(trx, {
        action: "access.granted",
        targetType: "booking",
        targetId: mine.id,
        at: t(1),
      });
      const revoked = await entry(trx, {
        action: "access.revoked",
        targetType: "user",
        targetId: learner.id,
        at: t(2),
      });
      // In two arms (actor and booking target), shown once.
      const moved = await entry(trx, {
        actorUserId: learner.id,
        action: "booking.rescheduled",
        targetType: "booking",
        targetId: mine.id,
        at: t(3),
      });
      const edited = await entry(trx, {
        actorUserId: admin.id,
        action: "user.updated",
        targetType: "user",
        targetId: learner.id,
        at: t(4),
      });
      await entry(trx, {
        action: "access.granted",
        targetType: "booking",
        targetId: theirs.id,
        at: t(5),
      });
      await entry(trx, {
        actorUserId: other.id,
        action: "booking.cancelled",
        targetType: "booking",
        targetId: theirs.id,
        at: t(6),
      });

      const page = await listAuditEvents(trx, { learner: learner.id }, "UTC");
      expect(page.rows.map((r) => r.id)).toEqual([
        edited.id,
        moved.id,
        revoked.id,
        granted.id,
      ]);
      // Other filters apply to every arm.
      const area = await listAuditEvents(
        trx,
        { learner: learner.id, area: "access_groups" },
        "UTC",
      );
      expect(area.rows.map((r) => r.id)).toEqual([revoked.id, granted.id]);
    }));

  // covers: AC-5, paging a learner with more than a page keeps arm order
  it("pages a long learner history in order across the arms", () =>
    inRollback(async (trx) => {
      const learner = await makeUser(trx);
      const type = await makeType(trx);
      const testbed = await makeTestbed(trx, type.id);
      const booking = await trx
        .insertInto("bookings")
        .values({
          user_id: learner.id,
          testbed_id: testbed.id,
          testbed_type_id: type.id,
          starts_at: new Date("2099-01-01T10:00:00Z"),
          ends_at: new Date("2099-01-01T12:00:00Z"),
          status: "completed",
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      // 120 entries, cycling through the three arms, one second apart.
      const seeded: string[] = [];
      for (let i = 0; i < 120; i++) {
        const arm = i % 3;
        const row = await entry(trx, {
          actorUserId: arm === 0 ? learner.id : null,
          action: arm === 2 ? "access.granted" : "booking.cancelled",
          targetType: arm === 1 ? "user" : "booking",
          targetId: arm === 1 ? learner.id : booking.id,
          at: new Date(FUTURE.getTime() + i * 1000),
        });
        seeded.push(row.id);
      }
      const base: AuditQuery = { learner: learner.id };
      const down = await walk(trx, base, "older");
      expect(down.pages).toBe(3);
      expect(down.ids).toEqual([...seeded].reverse());
      const up = await walk(trx, base, "newer", down.last);
      expect(new Set(up.ids)).toEqual(new Set(seeded));
    }));
});
