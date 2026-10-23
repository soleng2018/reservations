import "server-only";
import { sql, type Kysely } from "kysely";
import { audit } from "@/server/audit";
import type { CoreApi } from "@/server/authentik/client";
import {
  readTestbedGroup,
  testbedGroupMembers,
} from "@/server/authentik/groups";
import type { DB } from "@/server/db/types";

// Deleted testbed group release (spec 0017 AC-9), the step right after the
// access reconciler. The groups are the owner's, so nothing here deletes one:
// a deleted testbed's row is stamped once the app is done with its group, and
// from then on neither this step nor the reconciler looks at it again.
//
// Done means one of: a live testbed holds the same pk (`shared`), the group is
// gone (`gone`), or no member tagged `hol_learner` is left in it (`drained`,
// the reconciler having removed them). Anything else leaves the row for the
// next tick.

type Reason = "shared" | "gone" | "drained";

export async function releaseDeletedTestbeds(
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
      const reason = await releaseReason(
        api,
        conn,
        row.id,
        row.authentik_group_pk,
      );
      if (reason === undefined) return n;
      return (await stamp(conn, row.id, row.authentik_group_pk, reason))
        ? n + 1
        : n;
    } catch (e) {
      console.error(`release: testbed ${row.id} failed`, e);
      return n;
    }
  }, Promise.resolve(0));
}

// Why the group can be let go, or undefined to try again next tick.
async function releaseReason(
  api: CoreApi,
  conn: Kysely<DB>,
  testbedId: string,
  groupPk: string,
): Promise<Reason | undefined> {
  // A live testbed on the same group keeps it: no Authentik call.
  const live = await conn
    .selectFrom("testbeds")
    .select("id")
    .where("authentik_group_pk", "=", groupPk)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (live) return "shared";

  // A member list of a missing group is a 400, not a 404, so the group is
  // read first to tell "gone" apart.
  const group = await readTestbedGroup(api, groupPk);
  if (!group.ok) {
    if (group.error === "not_found") return "gone";
    console.error(
      `release: testbed ${testbedId} group ${groupPk}: ${group.error}`,
    );
    return undefined;
  }
  const members = await testbedGroupMembers(api, groupPk);
  if (!members.ok) {
    if (members.error === "not_found") return "gone";
    console.error(
      `release: testbed ${testbedId} could not read group ${groupPk} (${members.error})`,
    );
    return undefined;
  }
  const tagged = members.value.filter((m) => m.holLearner).length;
  if (tagged > 0) {
    console.warn(
      `release: testbed ${testbedId} group ${groupPk} still has ${tagged} tagged learner(s), skipped this tick`,
    );
    return undefined;
  }
  return "drained";
}

// Set once, with its audit row, in one transaction.
async function stamp(
  conn: Kysely<DB>,
  testbedId: string,
  groupPk: string,
  reason: Reason,
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
      action: "authentik_group.released",
      targetType: "authentik_group",
      targetId: groupPk,
      summary: "Testbed group released",
      metadata: { testbedId, reason },
    });
    return true;
  });
}
