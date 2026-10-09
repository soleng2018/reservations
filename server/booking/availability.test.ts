import { describe, expect, it } from "vitest";
import { LEAD_MS, SLOT_MS } from "@/lib/slots";
import { dbNow } from "@/server/db/bookings";
import {
  hasDb,
  inRollback,
  makeTestbed,
  makeType,
  makeUser,
} from "@/server/db/testing";
import { bookableTypes, startsFor } from "./availability";

const HOUR = 3_600_000;

// covers: AC-3
describe.skipIf(!hasDb)("availability (AC-3)", () => {
  it("lists only types with a bookable testbed", () =>
    inRollback(async (trx) => {
      const ready = await makeType(trx);
      await makeTestbed(trx, ready.id);
      const noGroup = await makeType(trx);
      await makeTestbed(trx, noGroup.id, { authentik_group_pk: null });
      const empty = await makeType(trx);
      const ids = (await bookableTypes(trx)).map((t) => t.id);
      expect(ids).toContain(ready.id);
      expect(ids).not.toContain(noGroup.id);
      expect(ids).not.toContain(empty.id);
    }));

  it("skips starts where every testbed of the type is busy", () =>
    inRollback(async (trx) => {
      const type = await makeType(trx, { duration_value: 2 });
      const testbed = await makeTestbed(trx, type.id);
      const now = await dbNow(trx);
      const first = Math.ceil((now.getTime() + LEAD_MS) / SLOT_MS) * SLOT_MS;
      const user = await makeUser(trx);
      await trx
        .insertInto("bookings")
        .values({
          user_id: user.id,
          testbed_id: testbed.id,
          testbed_type_id: type.id,
          starts_at: new Date(first + 2 * HOUR),
          ends_at: new Date(first + 4 * HOUR),
          status: "confirmed",
        })
        .execute();

      const starts = (await startsFor(trx, type.id)).map((d) => d.getTime());
      expect(starts[0]).toBe(first);
      expect(starts).not.toContain(first + HOUR);
      expect(starts).not.toContain(first + 3 * HOUR);
      expect(starts).toContain(first + 4 * HOUR);

      // A second testbed frees the busy window again.
      await makeTestbed(trx, type.id);
      expect((await startsFor(trx, type.id)).map((d) => d.getTime())).toContain(
        first + HOUR,
      );
    }));

  it("has nothing for an unknown type", () =>
    inRollback(async (trx) => {
      expect(await startsFor(trx, crypto.randomUUID())).toEqual([]);
    }));
});
