import { FetchError } from "@goauthentik/api/dist/esm/index.js";
import { sql } from "kysely";
import { afterAll, describe, expect, it } from "vitest";
import type { CoreApi } from "@/server/authentik/client";
import { fakeAuthentik, fakeGroup } from "@/server/authentik/testing";
import { db } from "@/server/db";
import { lockBookableTestbed } from "@/server/db/bookings";
import { hasDb, makeTestbed, makeType } from "@/server/db/testing";
import { deleteTestbedType, updateTestbedType } from "./testbed-types";

// Spec 0026 AC-19, task 9: a type edit never holds a booking up for an
// Authentik call. This needs a SECOND connection to see the first one's locks,
// and a second connection cannot see rows that are not committed, so this file
// is the one exception to the "DB tests never commit" rule in AGENTS.md: it
// commits a throwaway type (and a testbed) under a unique name, and removes
// them in `finally`.
//
// Nothing here leaves an audit row behind (audit_events is append only): the
// slow Authentik call is made to fail once the booking side has been checked,
// so the edit refuses and rolls back instead of committing.

const unique = () => crypto.randomUUID().slice(0, 8);

afterAll(() => (hasDb ? db().destroy() : undefined));

// An Authentik api whose first call matching `when` stops until `release()`,
// then fails like an unreachable server. `reached` resolves when it stops.
function slowApi(api: CoreApi, when: (method: string) => boolean) {
  let release!: () => void;
  let reach!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  const reached = new Promise<void>((r) => (reach = r));
  let stopped = false;
  const slow = new Proxy(api, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      const fn = value as (...args: unknown[]) => unknown;
      return async (...args: unknown[]) => {
        if (!stopped && when(String(prop))) {
          stopped = true;
          reach();
          await hold;
          throw new FetchError(new TypeError("fetch failed"));
        }
        return fn.apply(target, args);
      };
    },
  });
  return { api: slow, reached, release };
}

const editor = crypto.randomUUID();

// A committed type that owns an Authentik group the app made, plus the fake
// Authentik that holds that group.
async function seed(withTestbed: boolean) {
  const tag = unique();
  const id = crypto.randomUUID();
  const pk = crypto.randomUUID();
  const type = await makeType(db(), {
    id,
    name: `ZZ lock ${tag}`,
    authentik_group_pk: pk,
    authentik_group_origin: "created",
  });
  const testbed = withTestbed ? await makeTestbed(db(), type.id) : null;
  const ak = (usedBy: readonly string[] = []) =>
    fakeAuthentik([], {
      groups: [
        fakeGroup(pk, type.name, { hol_type_group: true, hol_type_id: id }),
      ],
      usedBy,
    });
  const cleanup = async () => {
    await db()
      .deleteFrom("testbeds")
      .where("testbed_type_id", "=", id)
      .execute();
    await db().deleteFrom("testbed_types").where("id", "=", id).execute();
  };
  return { tag, type, testbed, ak, cleanup };
}

// What a booking does first: lock the testbed and its type FOR SHARE, on its
// own connection, giving up after 2 seconds so a block fails the test fast.
const bookingLock = (testbedId: string) =>
  db()
    .transaction()
    .execute(async (b) => {
      await sql`set local lock_timeout = '2s'`.execute(b);
      return lockBookableTestbed(b, testbedId);
    });

describe.skipIf(!hasDb)("type edit never blocks a booking (AC-19)", () => {
  it("lets a booking lock the type while a rename waits on Authentik", async () => {
    const s = await seed(true);
    try {
      const slow = slowApi(s.ak().api, (m) => m === "coreGroupsPartialUpdate");
      const rename = updateTestbedType(
        db(),
        s.type.id,
        {
          name: `ZZ lock new ${s.tag}`,
          durationValue: 2,
          durationUnit: "hours",
        },
        editor,
        slow.api,
      );
      await slow.reached;

      const locked = await bookingLock(s.testbed?.id ?? "");
      expect(locked.ok).toBe(true);

      slow.release();
      expect(await rename).toEqual({ ok: false, error: "unavailable" });
    } finally {
      await s.cleanup();
    }
  });

  it("lets a booking lock the type while a delete is still reading Authentik", async () => {
    const s = await seed(true);
    try {
      // Held on the very first Authentik read, before the row lock.
      const slow = slowApi(s.ak().api, () => true);
      const del = deleteTestbedType(db(), s.type.id, editor, slow.api);
      await slow.reached;

      const locked = await bookingLock(s.testbed?.id ?? "");
      expect(locked.ok).toBe(true);

      slow.release();
      expect((await del).ok).toBe(false);
    } finally {
      await s.cleanup();
    }
  });

  it("blocks a booking only for the destroy call of a delete", async () => {
    const s = await seed(false);
    try {
      const slow = slowApi(s.ak().api, (m) => m === "coreGroupsDestroy");
      const del = deleteTestbedType(db(), s.type.id, editor, slow.api);
      await slow.reached;

      // The type row is locked FOR UPDATE now, so a share lock must wait.
      const shared = db()
        .transaction()
        .execute(async (b) => {
          await sql`set local lock_timeout = '300ms'`.execute(b);
          await b
            .selectFrom("testbed_types")
            .select("id")
            .where("id", "=", s.type.id)
            .forShare()
            .execute();
        });
      await expect(shared).rejects.toMatchObject({ code: "55P03" });

      slow.release();
      expect(await del).toEqual({ ok: false, error: { kind: "unavailable" } });
    } finally {
      await s.cleanup();
    }
  });
});
