import "server-only";
import { sql, type Kysely } from "kysely";
import { membershipDiff } from "@/lib/reconcile";
import { audit } from "@/server/audit";
import type { CoreApi } from "@/server/authentik/client";
import {
  addToPodGroup,
  podGroupMembers,
  removeFromPodGroup,
} from "@/server/authentik/groups";
import { guardGroupWrite } from "@/server/authentik/guard";
import { endAuthentikSessions } from "@/server/authentik/sessions";
import type { DB } from "@/server/db/types";

// The access reconciler (spec 0004 AC-12), the only code that adds or
// removes `pod-*` members. Each group's members are made to match the
// learners whose confirmed booking on that testbed is Current by the DB
// clock. A soft deleted testbed's group is emptied of tagged learners.

type Testbed = {
  readonly id: string;
  readonly groupPk: string;
  readonly deleted: boolean;
};

type Current = {
  readonly bookingId: string;
  readonly testbedId: string;
  readonly userId: string;
  readonly pk: number;
};

export async function reconcileAccess(
  api: CoreApi,
  conn: Kysely<DB>,
): Promise<void> {
  const testbeds = await conn
    .selectFrom("testbeds")
    .select(["id", "authentik_group_pk", "deleted_at"])
    .where("authentik_group_pk", "is not", null)
    .execute();
  const current = await conn
    .selectFrom("bookings as b")
    .innerJoin("users as u", "u.id", "b.user_id")
    .select([
      "b.id as bookingId",
      "b.testbed_id as testbedId",
      "u.id as userId",
      "u.authentik_user_pk as pk",
    ])
    .where("b.status", "=", "confirmed")
    .where("b.starts_at", "<=", sql<Date>`now()`)
    .where("b.ends_at", ">", sql<Date>`now()`)
    .where("u.authentik_user_pk", "is not", null)
    .execute();
  const live = current.flatMap((c) =>
    c.pk === null ? [] : [{ ...c, pk: c.pk }],
  );

  for (const t of testbeds) {
    if (!t.authentik_group_pk) continue;
    const testbed = {
      id: t.id,
      groupPk: t.authentik_group_pk,
      deleted: t.deleted_at !== null,
    };
    try {
      await reconcileGroup(api, conn, testbed, live);
    } catch (e) {
      console.error(`reconciler: group ${testbed.groupPk} failed`, e);
    }
  }
}

async function reconcileGroup(
  api: CoreApi,
  conn: Kysely<DB>,
  testbed: Testbed,
  current: readonly Current[],
): Promise<void> {
  const group = await guardGroupWrite(api, testbed.groupPk);
  if (!group.ok) {
    console.error(
      `reconciler: skipped group ${testbed.groupPk} (${group.error})`,
    );
    return;
  }
  const members = await podGroupMembers(api, testbed.groupPk);
  if (!members.ok) {
    console.error(
      `reconciler: could not read group ${testbed.groupPk} (${members.error})`,
    );
    return;
  }
  const desired = testbed.deleted
    ? []
    : current.filter((c) => c.testbedId === testbed.id);
  const diff = membershipDiff(new Set(desired.map((c) => c.pk)), members.value);

  for (const pk of diff.add) {
    const added = await addToPodGroup(api, testbed.groupPk, pk);
    if (!added.ok) {
      console.error(
        `reconciler: add ${pk} to ${testbed.groupPk}: ${added.error}`,
      );
      continue;
    }
    const booking = desired.find((c) => c.pk === pk);
    await audit(conn, {
      actorUserId: null,
      action: "access.granted",
      targetType: "booking",
      targetId: booking?.bookingId ?? testbed.id,
      summary: "Learner added to the testbed's access group",
      metadata: {
        testbedId: testbed.id,
        groupPk: testbed.groupPk,
        authentikUserPk: pk,
        userId: booking?.userId,
      },
    });
  }

  for (const pk of diff.remove) {
    const removed = await removeFromPodGroup(api, testbed.groupPk, pk);
    if (!removed.ok) {
      console.error(
        `reconciler: remove ${pk} from ${testbed.groupPk}: ${removed.error}`,
      );
      continue;
    }
    const user = await conn
      .selectFrom("users")
      .select("id")
      .where("authentik_user_pk", "=", pk)
      .executeTakeFirst();
    await audit(conn, {
      actorUserId: null,
      action: "access.revoked",
      targetType: user ? "user" : "authentik_group",
      targetId: user?.id ?? testbed.groupPk,
      summary: "Learner removed from the testbed's access group",
      metadata: {
        testbedId: testbed.id,
        groupPk: testbed.groupPk,
        authentikUserPk: pk,
      },
    });
    // Cuts off a learner already in the lab (they sign in again to manage
    // bookings; accepted). Membership is already gone, so a failure here is
    // logged, not retried.
    const ended = await endAuthentikSessions(api, pk);
    if (!ended.ok) console.error(`reconciler: could not end sessions of ${pk}`);
  }
}
