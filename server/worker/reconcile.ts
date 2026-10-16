import "server-only";
import { setTimeout as sleep } from "node:timers/promises";
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
import {
  makeRevoker,
  type CloudflareConfig,
  type RevokeSource,
  type VmRevoke,
  type VmRevoker,
} from "@/server/cloudflare/access";
import type { DB } from "@/server/db/types";

// The access reconciler (spec 0004 AC-12), the only code that adds or
// removes `pod-*` members. Each group's members are made to match the
// learners whose confirmed booking on that testbed is Current by the DB
// clock. A soft deleted testbed's group is emptied of tagged learners. Each
// removal also ends the learner's Authentik sessions and, when the revoke is
// on, makes Cloudflare Access refuse their new requests (spec 0012 AC-10).
// This is the only caller of that revoke.

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

// One run's VM revoke: `off` when there is no live CLOUDFLARE key.
type RunRevoke = (email: string | null) => Promise<VmRevoke | "off">;

const liveRevoker = (config: CloudflareConfig): VmRevoker =>
  makeRevoker(config, { sleep });

// AC-11: a key the worker can't read records every revoke as failed with no
// call, and says so once per run, only when the run had a removal.
const brokenRevoke = (): RunRevoke => {
  let said = false;
  return async () => {
    if (!said) {
      said = true;
      console.error("reconciler: Cloudflare revoke key can't be read");
    }
    return "failed";
  };
};

const runRevoke = (
  source: RevokeSource,
  newRevoker: (config: CloudflareConfig) => VmRevoker,
): RunRevoke => {
  switch (source.kind) {
    case "off":
      return async () => "off";
    case "broken":
      return brokenRevoke();
    case "on": {
      const revoker = newRevoker(source.config);
      // No users row means no email: failed, with no call and no trip.
      return async (email) => (email === null ? "failed" : revoker(email));
    }
    default: {
      const never: never = source;
      throw new Error(`unknown revoke source: ${String(never)}`);
    }
  }
};

// `revokeSource` is read once at the start of each run, so a rotated token
// takes effect on the next run; the revoker it yields (retries, breaker)
// lives for this run only. `newRevoker` is a seam for tests.
export async function reconcileAccess(
  api: CoreApi,
  conn: Kysely<DB>,
  revokeSource: () => Promise<RevokeSource>,
  newRevoker: (config: CloudflareConfig) => VmRevoker = liveRevoker,
): Promise<void> {
  const revoke = runRevoke(await revokeSource(), newRevoker);
  const testbeds = await conn
    .selectFrom("testbeds")
    .select(["id", "authentik_group_pk", "deleted_at"])
    .where("authentik_group_pk", "is not", null)
    // Torn down (spec 0007 AC-7): the group no longer exists.
    .where("authentik_group_deleted_at", "is", null)
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
    // Spec 0008 AC-11: a deactivated learner is never a desired member,
    // even if a confirmed booking slipped past the deactivation.
    .where("u.status", "=", "active")
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
      await reconcileGroup(api, conn, testbed, live, revoke);
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
  revoke: RunRevoke,
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
      .select(["id", "email"])
      .where("authentik_user_pk", "=", pk)
      .executeTakeFirst();
    const who = user ? `user ${user.id}` : `pk ${pk}`;
    // Membership is already gone, so neither step is retried after this
    // run: a failure is logged (by id, never the email) and audited.
    // Ending the Authentik sessions forces a fresh sign in, which HOL Labs
    // then refuses (they sign in again to manage bookings; accepted). The VM
    // revoke runs even when that failed (AC-10).
    const ended = await endAuthentikSessions(api, pk);
    if (!ended.ok) console.error(`reconciler: could not end sessions of ${pk}`);
    const vmRevoke = await revoke(user?.email ?? null);
    if (vmRevoke === "failed")
      console.error(`reconciler: Cloudflare VM revoke failed for ${who}`);
    // AC-12: written last, so it records what happened.
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
        sessionsEnded: ended.ok,
        vmRevoke,
      },
    });
  }
}
