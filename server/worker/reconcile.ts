import "server-only";
import { setTimeout as sleep } from "node:timers/promises";
import { sql, type Kysely } from "kysely";
import {
  groupByPk,
  isStalePk,
  membershipDiff,
  type GroupRow,
} from "@/lib/reconcile";
import type { Result } from "@/lib/result";
import { audit } from "@/server/audit";
import type { AuthentikFailure, CoreApi } from "@/server/authentik/client";
import {
  addToTestbedGroup,
  findTestbedGroup,
  readTestbedGroup,
  removeFromTestbedGroup,
  testbedGroupMembers,
  type MembershipError,
  type TestbedGroup,
} from "@/server/authentik/groups";
import { endAuthentikSessions } from "@/server/authentik/sessions";
import {
  makeRevoker,
  type CloudflareConfig,
  type RevokeSource,
  type VmRevoke,
  type VmRevoker,
} from "@/server/cloudflare/access";
import { mapConstraintError } from "@/server/db/constraint-errors";
import type { DB } from "@/server/db/types";

// The access reconciler (spec 0004 AC-12, spec 0017 AC-10), the only code
// that adds or removes testbed group members. It works per distinct group pk:
// the members of a group are made to match the learners whose confirmed
// booking on any live testbed holding that pk is Current by the DB clock. A
// soft deleted testbed adds no one, so its group is emptied of tagged
// learners. Each removal also ends the learner's Authentik sessions and, when
// the revoke is on, makes Cloudflare Access refuse their new requests (spec
// 0012 AC-10). This is the only caller of that revoke.
//
// The groups are the owner's: the reconciler never creates or deletes one. A
// live testbed whose stored pk went stale (the group is gone, or renamed) is
// found again by the testbed's group name, and only the database row changes.

type GroupRead = Result<TestbedGroup, AuthentikFailure>;

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
  const rows = await unreleasedTestbeds(conn);
  const current = await currentLearners(conn);

  // Each stored pk is read once. A relinked testbed adds its new group's read.
  const reads = new Map<string, GroupRead>();
  for (const { pk } of groupByPk(rows))
    reads.set(pk, await readTestbedGroup(api, pk));

  const { resolved, skippedPks } = await relinkStale(api, conn, rows, reads);

  for (const { pk, rows: group } of groupByPk(resolved)) {
    const read = reads.get(pk);
    if (skippedPks.has(pk) || !read) continue;
    try {
      await reconcileGroup(api, conn, pk, group, read, current, revoke);
    } catch (e) {
      console.error(`reconciler: group ${pk} failed`, e);
    }
  }
}

// Every testbed whose group the app is not done with: live ones, and deleted
// ones until the release step stamps them (spec 0017 AC-9).
async function unreleasedTestbeds(
  conn: Kysely<DB>,
): Promise<readonly GroupRow[]> {
  const rows = await conn
    .selectFrom("testbeds")
    .select(["id", "group_name", "authentik_group_pk", "deleted_at"])
    .where("authentik_group_pk", "is not", null)
    .where("authentik_group_deleted_at", "is", null)
    .orderBy("created_at")
    .execute();
  return rows.flatMap((t) =>
    t.authentik_group_pk === null
      ? []
      : [
          {
            id: t.id,
            groupName: t.group_name,
            groupPk: t.authentik_group_pk,
            deleted: t.deleted_at !== null,
          },
        ],
  );
}

async function currentLearners(conn: Kysely<DB>): Promise<readonly Current[]> {
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
  return current.flatMap((c) => (c.pk === null ? [] : [{ ...c, pk: c.pk }]));
}

// Spec 0017 AC-10 (c). A live testbed's stored pk is stale when the group is
// gone or its name is no longer the testbed's group name. The group with that
// group name is then looked up; when it is usable and no other live testbed
// holds it, its pk is stored and the run carries on with it. Otherwise one
// error is logged for the testbed and its pk is left alone this tick, so
// nothing is written to a stale group. A deleted testbed's stale pk is never
// relinked and logs nothing: the release step stamps it.
async function relinkStale(
  api: CoreApi,
  conn: Kysely<DB>,
  rows: readonly GroupRow[],
  reads: Map<string, GroupRead>,
): Promise<{
  readonly resolved: readonly GroupRow[];
  readonly skippedPks: ReadonlySet<string>;
}> {
  const stale = rows.filter((r) => {
    const read = reads.get(r.groupPk);
    if (r.deleted || !read) return false;
    // Unavailable says nothing about the group: the group step logs it.
    if (!read.ok) return read.error === "not_found";
    return isStalePk(r, read.value);
  });
  const moved = new Map<string, TestbedGroup>();
  const skippedPks = new Set<string>();
  for (const row of stale) {
    let group: TestbedGroup | undefined;
    try {
      group = await relinkByName(api, conn, row, rows);
    } catch (e) {
      console.error(`reconciler: testbed ${row.id} relink failed`, e);
    }
    if (group) {
      moved.set(row.id, group);
      reads.set(group.pk, { ok: true, value: group });
    } else skippedPks.add(row.groupPk);
  }
  return {
    resolved: rows.map((r) => {
      const group = moved.get(r.id);
      return group ? { ...r, groupPk: group.pk } : r;
    }),
    skippedPks,
  };
}

async function relinkByName(
  api: CoreApi,
  conn: Kysely<DB>,
  row: GroupRow,
  rows: readonly GroupRow[],
): Promise<TestbedGroup | undefined> {
  const found = await findTestbedGroup(api, row.groupName);
  if (!found.ok) {
    console.error(
      `reconciler: testbed ${row.id} group ${row.groupPk} is stale and no usable group has the testbed's group name (${found.error}), skipped`,
    );
    return undefined;
  }
  const taken = rows.some(
    (o) => !o.deleted && o.id !== row.id && o.groupPk === found.value.pk,
  );
  if (taken || found.value.pk === row.groupPk) {
    console.error(
      `reconciler: testbed ${row.id} group ${row.groupPk} is stale and the group with its group name is not free, skipped`,
    );
    return undefined;
  }
  try {
    const stored = await conn.transaction().execute(async (trx) => {
      const updated = await trx
        .updateTable("testbeds")
        .set({ authentik_group_pk: found.value.pk })
        .where("id", "=", row.id)
        .where("authentik_group_pk", "=", row.groupPk)
        .where("deleted_at", "is", null)
        .returning("id")
        .executeTakeFirst();
      if (!updated) return false;
      await audit(trx, {
        actorUserId: null,
        action: "testbed.group_relinked",
        targetType: "testbed",
        targetId: row.id,
        summary: "Testbed group found again by group name",
        metadata: { testbedId: row.id, from: row.groupPk, to: found.value.pk },
      });
      return true;
    });
    return stored ? found.value : undefined;
  } catch (e) {
    // The unique index decided: another live testbed took the group meanwhile.
    const mapped = mapConstraintError(e);
    if (!mapped.ok && mapped.error === "group_in_use") return undefined;
    throw e;
  }
}

// One group, made to match the learners wanted in it. The group is read
// again before every write (the guard), so an add needs a usable group and a
// removal needs only that the group is not hol-admins. Failures are logged
// once for the testbed with their count, not once per learner.
async function reconcileGroup(
  api: CoreApi,
  conn: Kysely<DB>,
  groupPk: string,
  rows: readonly GroupRow[],
  read: GroupRead,
  current: readonly Current[],
  revoke: RunRevoke,
): Promise<void> {
  const live = rows.filter((r) => !r.deleted);
  const label = live[0] ?? rows[0];
  if (!label) return;
  if (!read.ok) {
    // A deleted testbed's missing group needs no word: the release step
    // stamps it.
    if (read.error !== "not_found" || live.length > 0)
      console.error(
        `reconciler: testbed ${label.id} could not read group ${groupPk} (${read.error})`,
      );
    return;
  }
  const members = await testbedGroupMembers(api, groupPk);
  if (!members.ok) {
    console.error(
      `reconciler: testbed ${label.id} could not read the members of group ${groupPk} (${members.error})`,
    );
    return;
  }
  const liveIds = new Set(live.map((r) => r.id));
  const desired = current.filter((c) => liveIds.has(c.testbedId));
  const diff = membershipDiff(new Set(desired.map((c) => c.pk)), members.value);

  const addFailures: MembershipError[] = [];
  for (const pk of diff.add) {
    const added = await addToTestbedGroup(api, groupPk, pk);
    if (!added.ok) {
      addFailures.push(added.error);
      continue;
    }
    const booking = desired.find((c) => c.pk === pk);
    await audit(conn, {
      actorUserId: null,
      action: "access.granted",
      targetType: "booking",
      targetId: booking?.bookingId ?? label.id,
      summary: "Learner added to the testbed's access group",
      metadata: {
        testbedId: booking?.testbedId ?? label.id,
        groupPk,
        authentikUserPk: pk,
        userId: booking?.userId,
      },
    });
  }
  logFailures(label.id, groupPk, "add", addFailures);

  const removeFailures: MembershipError[] = [];
  for (const pk of diff.remove) {
    const removed = await removeFromTestbedGroup(api, groupPk, pk);
    if (!removed.ok) {
      removeFailures.push(removed.error);
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
      targetId: user?.id ?? groupPk,
      summary: "Learner removed from the testbed's access group",
      metadata: {
        testbedId: label.id,
        groupPk,
        authentikUserPk: pk,
        sessionsEnded: ended.ok,
        vmRevoke,
      },
    });
  }
  logFailures(label.id, groupPk, "removal", removeFailures);
}

// One line per testbed and kind: how many writes were refused, and why.
function logFailures(
  testbedId: string,
  groupPk: string,
  what: "add" | "removal",
  errors: readonly MembershipError[],
): void {
  if (errors.length === 0) return;
  console.error(
    `reconciler: testbed ${testbedId} group ${groupPk}: ${errors.length} ${what}(s) refused (${[...new Set(errors)].join(", ")})`,
  );
}
