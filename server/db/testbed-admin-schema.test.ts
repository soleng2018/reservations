import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { attempt, hasDb, inRollback, makeTestbed, makeType } from "./testing";

// Spec 0007 AC-8: the testbed admin migration's named checks. Their names
// are a contract, so each refusal is asserted by name.
describe.skipIf(!hasDb)("testbed admin checks (AC-8)", () => {
  afterAll(() => db().destroy());

  it("stamps a group teardown only on a soft deleted testbed", () =>
    inRollback(async (trx) => {
      const type = await makeType(trx);
      const live = await makeTestbed(trx, type.id);
      const stamp = (id: string) =>
        trx
          .updateTable("testbeds")
          .set({ authentik_group_deleted_at: new Date() })
          .where("id", "=", id)
          .execute();
      expect(await attempt(trx, () => stamp(live.id))).toMatchObject({
        constraint: "testbeds_group_deleted_after_delete_check",
      });
      const deleted = await makeTestbed(trx, type.id, {
        deleted_at: new Date(),
      });
      expect(await attempt(trx, () => stamp(deleted.id))).toBeUndefined();
    }));

  it.each([
    [{ os_username: "" }, "testbed_clients_os_username_length_check"],
    [
      { os_username: "u".repeat(201) },
      "testbed_clients_os_username_length_check",
    ],
    [
      { os_username: "u", os_password: "" },
      "testbed_clients_os_password_length_check",
    ],
    [
      { os_username: "u", os_password: "p".repeat(201) },
      "testbed_clients_os_password_length_check",
    ],
    [{ os_password: "p" }, "testbed_clients_password_needs_username_check"],
  ])("refuses the client %o by %s", (login, constraint) =>
    inRollback(async (trx) => {
      const type = await makeType(trx);
      const tb = await makeTestbed(trx, type.id);
      const insert = (over: object) =>
        trx
          .insertInto("testbed_clients")
          .values({
            testbed_id: tb.id,
            kind: "wired",
            name: "W",
            url: "https://w.example.test",
            position: 0,
            ...over,
          })
          .execute();
      expect(await attempt(trx, () => insert(login))).toMatchObject({
        constraint,
      });
      expect(
        await attempt(trx, () =>
          insert({
            os_username: "u".repeat(200),
            os_password: " ".repeat(200),
          }),
        ),
      ).toBeUndefined();
    }),
  );
});
