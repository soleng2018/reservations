import { readFileSync } from "node:fs";
import path from "node:path";
import { sql } from "kysely";
import { afterAll, describe, expect, it } from "vitest";
import { INVALID_DOMAINS, VALID_DOMAINS } from "@/lib/domain-samples";
import { db } from "@/server/db";
import { attempt, hasDb, inRollback, makeTestbed, makeType } from "./testing";

// Spec 0017 AC-11: the testbed domain migration's named checks and indexes.
// Their names are a contract with constraint-errors.ts, so each refusal is
// asserted by name.
describe.skipIf(!hasDb)("testbed domain checks (spec 0017 AC-11)", () => {
  afterAll(() => db().destroy());

  it.each([...VALID_DOMAINS])("the format check accepts %s", (domain) =>
    inRollback(async (trx) => {
      const type = await makeType(trx);
      expect(
        await attempt(trx, () => makeTestbed(trx, type.id, { domain })),
      ).toBeUndefined();
    }),
  );

  it.each([...INVALID_DOMAINS])("the format check refuses %s", (domain) =>
    inRollback(async (trx) => {
      const type = await makeType(trx);
      expect(
        await attempt(trx, () => makeTestbed(trx, type.id, { domain })),
      ).toMatchObject({ constraint: "testbeds_domain_format_check" });
    }),
  );

  it("refuses an upper case domain (the app stores it lower case)", () =>
    inRollback(async (trx) => {
      const type = await makeType(trx);
      expect(
        await attempt(trx, () =>
          makeTestbed(trx, type.id, { domain: "Nile.Global" }),
        ),
      ).toMatchObject({ constraint: "testbeds_domain_format_check" });
    }));

  it("requires a domain and a group pk on a live row only", () =>
    inRollback(async (trx) => {
      const type = await makeType(trx);
      expect(
        await attempt(trx, () => makeTestbed(trx, type.id, { domain: null })),
      ).toMatchObject({ constraint: "testbeds_domain_live_check" });
      expect(
        await attempt(trx, () =>
          makeTestbed(trx, type.id, { authentik_group_pk: null }),
        ),
      ).toMatchObject({ constraint: "testbeds_live_group_check" });
      expect(
        await attempt(trx, () =>
          makeTestbed(trx, type.id, {
            domain: null,
            authentik_group_pk: null,
            deleted_at: new Date(),
          }),
        ),
      ).toBeUndefined();
    }));

  it("allows one live testbed per domain, and frees it on a soft delete", () =>
    inRollback(async (trx) => {
      const type = await makeType(trx);
      const first = await makeTestbed(trx, type.id, {
        domain: "unique-one.example.test",
      });
      expect(
        await attempt(trx, () =>
          makeTestbed(trx, type.id, { domain: "unique-one.example.test" }),
        ),
      ).toMatchObject({ constraint: "testbeds_domain_uq" });
      await trx
        .updateTable("testbeds")
        .set({ deleted_at: new Date() })
        .where("id", "=", first.id)
        .execute();
      expect(
        await attempt(trx, () =>
          makeTestbed(trx, type.id, { domain: "unique-one.example.test" }),
        ),
      ).toBeUndefined();
    }));

  it("allows one live testbed per group pk, and frees it on a soft delete", () =>
    inRollback(async (trx) => {
      const type = await makeType(trx);
      const pk = crypto.randomUUID();
      const first = await makeTestbed(trx, type.id, {
        authentik_group_pk: pk,
      });
      expect(
        await attempt(trx, () =>
          makeTestbed(trx, type.id, { authentik_group_pk: pk }),
        ),
      ).toMatchObject({ constraint: "testbeds_group_pk_uq" });
      await trx
        .updateTable("testbeds")
        .set({ deleted_at: new Date() })
        .where("id", "=", first.id)
        .execute();
      expect(
        await attempt(trx, () =>
          makeTestbed(trx, type.id, { authentik_group_pk: pk }),
        ),
      ).toBeUndefined();
    }));

  // The guard block of 0013, run again in a rolled back transaction. The
  // migration itself is applied once, so the block is cut out of the file.
  describe("the migration guard", () => {
    const file = readFileSync(
      path.resolve(process.cwd(), "db/migrations/0013_testbed_domain.sql"),
      "utf8",
    );
    const guard = /do \$\$[\s\S]*?end \$\$;/.exec(file)?.[0];

    const runGuard = (trx: Parameters<typeof attempt>[0]) =>
      attempt(trx, () => sql.raw(guard ?? "select 1/0").execute(trx));

    // Live rows of the shared database would trip the first guard, so they
    // are soft deleted here and put back by the rollback.
    const hideLiveTestbeds = (trx: Parameters<typeof attempt>[0]) =>
      trx
        .updateTable("testbeds")
        .set({ deleted_at: new Date(), authentik_group_deleted_at: new Date() })
        .where("deleted_at", "is", null)
        .execute();

    it("is found in the migration file", () => {
      expect(guard).toBeDefined();
    });

    it("raises while a live testbed exists, naming the step", () =>
      inRollback(async (trx) => {
        const type = await makeType(trx);
        await makeTestbed(trx, type.id);
        expect(await runGuard(trx)).toMatchObject({
          message: "Delete every live testbed first (spec 0017).",
        });
      }));

    it("raises while a deleted testbed's group release is pending", () =>
      inRollback(async (trx) => {
        const type = await makeType(trx);
        await hideLiveTestbeds(trx);
        await makeTestbed(trx, type.id, { deleted_at: new Date() });
        expect(await runGuard(trx)).toMatchObject({
          message:
            "Wait for every deleted testbed's group release first (spec 0017).",
        });
      }));

    it("passes with only released deleted testbeds", () =>
      inRollback(async (trx) => {
        await hideLiveTestbeds(trx);
        const type = await makeType(trx);
        await makeTestbed(trx, type.id, {
          deleted_at: new Date(),
          authentik_group_deleted_at: new Date(),
        });
        expect(await runGuard(trx)).toBeUndefined();
      }));
  });
});
