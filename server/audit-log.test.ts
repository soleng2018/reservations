import type { Kysely } from "kysely";
import { afterAll, describe, expect, it } from "vitest";
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
import { listAuditEvents, resolveTargets, targetKey } from "./audit-log";

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
      });

      const page = await listAuditEvents(trx, "UTC");
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

      const [booked, granted] = (await listAuditEvents(trx, "UTC")).rows;

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
