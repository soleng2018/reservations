import "server-only";
import { sql, type Kysely } from "kysely";
import { audit } from "@/server/audit";
import type { CoreApi } from "@/server/authentik/client";
import { deletePodGroup, podGroupMembers } from "@/server/authentik/groups";
import { guardGroupWrite } from "@/server/authentik/guard";
import type { DB } from "@/server/db/types";

// Deleted testbed group teardown (spec 0007 AC-7), the step right after the
// access reconciler. A group goes only once the reconciler has emptied it of
// tagged learners (ending their sessions), and only if it still carries this
// testbed's id. Untagged members never stop it. A row is stamped once, after
// Authentik confirmed the group is gone; anything else leaves it for the
// next tick.

type Gone = "removed" | "already_gone";

const SUMMARY: Readonly<Record<Gone, string>> = {
  removed: "Access group of a deleted testbed removed",
  already_gone: "Access group of a deleted testbed was already gone",
};

export async function teardownDeletedTestbeds(
  api: CoreApi,
  conn: Kysely<DB>,
): Promise<number> {
  const rows = await conn
    .selectFrom("testbeds")
    .select(["id", "authentik_group_pk"])
    .where("deleted_at", "is not", null)
    .where("authentik_group_pk", "is not", null)
    .where("authentik_group_deleted_at", "is", null)
    .execute();
  return rows.reduce<Promise<number>>(async (count, row) => {
    const n = await count;
    if (!row.authentik_group_pk) return n;
    try {
      const gone = await teardownGroup(api, row.id, row.authentik_group_pk);
      if (gone === undefined) return n;
      return (await stamp(conn, row.id, row.authentik_group_pk, gone))
        ? n + 1
        : n;
    } catch (e) {
      console.error(`teardown: testbed ${row.id} failed`, e);
      return n;
    }
  }, Promise.resolve(0));
}

// What Authentik says about the group, or undefined to try again next tick.
async function teardownGroup(
  api: CoreApi,
  testbedId: string,
  groupPk: string,
): Promise<Gone | undefined> {
  // A member list of a missing group is a 400, not a 404, so the group is
  // read first to tell "already gone" apart.
  const group = await guardGroupWrite(api, groupPk);
  if (!group.ok) {
    if (group.error === "not_found") return "already_gone";
    console.error(
      `teardown: testbed ${testbedId} group ${groupPk}: ${group.error}`,
    );
    return undefined;
  }
  const members = await podGroupMembers(api, groupPk);
  if (!members.ok) {
    if (members.error === "not_found") return "already_gone";
    console.error(
      `teardown: testbed ${testbedId} could not read group ${groupPk} (${members.error})`,
    );
    return undefined;
  }
  const tagged = members.value.filter((m) => m.holLearner).length;
  if (tagged > 0) {
    console.warn(
      `teardown: testbed ${testbedId} group ${groupPk} still has ${tagged} tagged learner(s), skipped this tick`,
    );
    return undefined;
  }
  const deleted = await deletePodGroup(api, groupPk, testbedId);
  if (deleted.ok) return "removed";
  if (deleted.error === "not_found") return "already_gone";
  console.error(
    `teardown: testbed ${testbedId} group ${groupPk}: ${deleted.error}`,
  );
  return undefined;
}

// Set once, with its audit row, in one transaction.
async function stamp(
  conn: Kysely<DB>,
  testbedId: string,
  groupPk: string,
  gone: Gone,
): Promise<boolean> {
  return conn.transaction().execute(async (trx) => {
    const row = await trx
      .updateTable("testbeds")
      .set({ authentik_group_deleted_at: sql<Date>`now()` })
      .where("id", "=", testbedId)
      .where("authentik_group_deleted_at", "is", null)
      .returning("id")
      .executeTakeFirst();
    if (!row) return false;
    await audit(trx, {
      actorUserId: null,
      action: "authentik_group.deleted",
      targetType: "authentik_group",
      targetId: groupPk,
      summary: SUMMARY[gone],
      metadata: { testbedId },
    });
    return true;
  });
}
