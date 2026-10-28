import { randomUUID } from "node:crypto";
import { sql, type Transaction } from "kysely";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { asConn, hasDb, inRollback, makeUser } from "@/server/db/testing";
import type { DB } from "@/server/db/types";
import { seedPortalReset } from "./seed";
import { readResetList, savePortalReset } from "./steps";

afterAll(() => db().destroy());

const wait = (seconds: number) => ({ parts: [{ kind: "wait", seconds }] });

// A database as a fresh install leaves it: the 13 starting steps, version 1.
const fresh = async (trx: Transaction<DB>) => {
  await trx.deleteFrom("portal_reset_steps").execute();
  await trx
    .updateTable("portal_reset_settings")
    .set({
      seeded_at: null,
      version: 1,
      abort_email: null,
      mode: "off",
      mode_changed_at: null,
      updated_by: null,
    })
    .execute();
  await seedPortalReset(asConn(trx));
  return makeUser(trx, { role: "admin", name: "Ada Admin" });
};

type Draft = {
  id?: string;
  seedKey?: string;
  featureName: string;
  enabled: boolean;
  note: string | null;
  definition: unknown;
};

const draftOf = async (trx: Transaction<DB>): Promise<Draft[]> =>
  (await readResetList(asConn(trx))).steps.flatMap((s) =>
    s.ok
      ? [
          {
            id: s.step.id,
            featureName: s.step.featureName,
            enabled: s.step.enabled,
            note: s.step.note,
            definition: s.step.definition,
          },
        ]
      : [],
  );

const send = (
  trx: Transaction<DB>,
  adminId: string,
  steps: readonly Draft[],
  over: Record<string, unknown> = {},
) =>
  savePortalReset(
    asConn(trx),
    { expectedVersion: 1, abortEmail: "", mode: "off", steps, ...over },
    adminId,
  );

// Only the rows this test's own transaction wrote: `now()` is the start of the
// transaction, so rows other runs committed (a Save from the e2e flow, which
// the append only log keeps) are not counted.
const audits = async (trx: Transaction<DB>) =>
  trx
    .selectFrom("audit_events")
    .selectAll()
    .where("action", "like", "portal_reset.%")
    .where("action", "<>", "portal_reset.seeded")
    .where("created_at", "=", sql<Date>`now()`)
    .execute();

const positions = async (trx: Transaction<DB>) =>
  (
    await trx
      .selectFrom("portal_reset_steps")
      .select("position")
      .orderBy("position")
      .execute()
  ).map((r) => r.position);

const names = async (trx: Transaction<DB>) =>
  (await readResetList(asConn(trx))).steps.map((s) =>
    s.ok ? s.step.featureName : "?",
  );

const settings = (trx: Transaction<DB>) =>
  trx.selectFrom("portal_reset_settings").selectAll().executeTakeFirstOrThrow();

// The same JSON with every object's keys in the opposite order.
const reverseKeys = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(reverseKeys)
    : typeof value === "object" && value !== null
      ? Object.fromEntries(
          Object.entries(value)
            .reverse()
            .map(([k, v]) => [k, reverseKeys(v)]),
        )
      : value;

const newStep = (featureName: string, over: Partial<Draft> = {}): Draft => ({
  featureName,
  enabled: true,
  note: null,
  definition: wait(2),
  ...over,
});

describe.skipIf(!hasDb)("savePortalReset", () => {
  it("AC-7: writes the email, the mode, and the list, and a reload shows them", async () => {
    await inRollback(async (trx) => {
      const admin = await fresh(trx);
      const draft = await draftOf(trx);
      const [first, second, ...rest] = draft;
      if (!first || !second) throw new Error("no steps");
      const result = await send(
        trx,
        admin.id,
        [second, newStep("Brand new"), first, ...rest],
        { abortEmail: " Ops@Example.com ", mode: "dry_run" },
      );
      expect(result).toEqual({
        ok: true,
        value: { version: 2, changed: true },
      });
      await sql`set constraints all immediate`.execute(trx);

      const list = await readResetList(asConn(trx));
      expect(list).toMatchObject({
        version: 2,
        abortEmail: "ops@example.com",
        mode: "dry_run",
      });
      expect(await names(trx)).toEqual([
        second.featureName,
        "Brand new",
        first.featureName,
        ...rest.map((r) => r.featureName),
      ]);
      expect(await positions(trx)).toEqual(
        Array.from({ length: 14 }, (_, i) => i + 1),
      );
      const row = await settings(trx);
      expect(row.updated_by).toBe(admin.id);
      expect(row.mode_changed_at).not.toBeNull();
    });
  });

  it("keeps positions exactly 1 to N after a removal that shifts the others", async () => {
    await inRollback(async (trx) => {
      const admin = await fresh(trx);
      const draft = await draftOf(trx);
      const result = await send(
        trx,
        admin.id,
        draft.filter((_, i) => i !== 1 && i !== 4),
      );
      expect(result.ok).toBe(true);
      await sql`set constraints all immediate`.execute(trx);
      expect(await positions(trx)).toEqual(
        Array.from({ length: 11 }, (_, i) => i + 1),
      );
    });
  });

  it("AC-11: a stale Save writes nothing and says stale", async () => {
    await inRollback(async (trx) => {
      const admin = await fresh(trx);
      const draft = await draftOf(trx);
      const before = await audits(trx);
      const result = await send(trx, admin.id, draft.slice(0, 3), {
        expectedVersion: 7,
        mode: "live",
      });
      expect(result).toEqual({ ok: false, error: { kind: "stale" } });
      expect(await names(trx)).toHaveLength(13);
      expect(await audits(trx)).toEqual(before);
      expect(await settings(trx)).toMatchObject({ version: 1, mode: "off" });
    });
  });

  it("AC-12: a Save with no change writes no audit row and keeps the version", async () => {
    await inRollback(async (trx) => {
      const admin = await fresh(trx);
      const draft = await draftOf(trx);
      const result = await send(trx, admin.id, draft);
      expect(result).toEqual({
        ok: true,
        value: { version: 1, changed: false },
      });
      expect(await audits(trx)).toEqual([]);
      expect((await settings(trx)).updated_by).toBeNull();
    });
  });

  it("is no change when the definition differs only by key order and spaces", async () => {
    await inRollback(async (trx) => {
      const admin = await fresh(trx);
      const draft = await draftOf(trx);
      const [first, ...rest] = draft;
      if (!first) throw new Error("no steps");
      const reordered = {
        ...first,
        featureName: ` ${first.featureName} `,
        definition: reverseKeys(first.definition),
      };
      const result = await send(trx, admin.id, [reordered, ...rest]);
      expect(result).toEqual({
        ok: true,
        value: { version: 1, changed: false },
      });
    });
  });

  it("swaps two feature names in one Save", async () => {
    await inRollback(async (trx) => {
      const admin = await fresh(trx);
      const [a, b, ...rest] = await draftOf(trx);
      if (!a || !b) throw new Error("no steps");
      const result = await send(trx, admin.id, [
        { ...a, featureName: b.featureName },
        { ...b, featureName: a.featureName },
        ...rest,
      ]);
      expect(result.ok).toBe(true);
      await sql`set constraints all immediate`.execute(trx);
      expect((await names(trx)).slice(0, 2)).toEqual([
        b.featureName,
        a.featureName,
      ]);
    });
  });

  it("renames a step onto the name of a step removed in the same Save", async () => {
    await inRollback(async (trx) => {
      const admin = await fresh(trx);
      const [a, b, ...rest] = await draftOf(trx);
      if (!a || !b) throw new Error("no steps");
      const result = await send(trx, admin.id, [
        { ...a, featureName: b.featureName },
        ...rest,
      ]);
      expect(result.ok).toBe(true);
      expect((await names(trx))[0]).toBe(b.featureName);
    });
  });

  it("rolls everything back when a write fails inside the transaction", async () => {
    await inRollback(async (trx) => {
      await fresh(trx);
      const draft = await draftOf(trx);
      const before = await names(trx);
      const auditsBefore = await audits(trx);
      // An admin id that is no user: the settings row's foreign key refuses it
      // after the step writes, so the whole Save must undo them.
      await expect(
        send(trx, randomUUID(), [...draft.slice(1), newStep("Added")], {
          mode: "live",
        }),
      ).rejects.toMatchObject({ code: "23503" });
      expect(await names(trx)).toEqual(before);
      expect(await audits(trx)).toEqual(auditsBefore);
      expect(await settings(trx)).toMatchObject({ version: 1, mode: "off" });
    });
  });

  it("refuses with field errors and writes nothing", async () => {
    await inRollback(async (trx) => {
      const admin = await fresh(trx);
      const draft = await draftOf(trx);
      const result = await send(trx, admin.id, draft, {
        abortEmail: "nope",
        mode: "on",
      });
      expect(result.ok).toBe(false);
      expect(
        !result.ok &&
          result.error.kind === "invalid" &&
          Object.keys(result.error.fields).sort(),
      ).toEqual(["abortEmail", "mode"]);
      expect(await audits(trx)).toEqual([]);
    });
  });

  describe("the checks that need the stored rows", () => {
    it("refuses an id that is not a row", async () => {
      await inRollback(async (trx) => {
        const admin = await fresh(trx);
        const [first, ...rest] = await draftOf(trx);
        if (!first) throw new Error("no steps");
        const result = await send(trx, admin.id, [
          { ...first, id: randomUUID() },
          ...rest,
        ]);
        expect(result).toEqual({ ok: false, error: { kind: "unknown_step" } });
      });
    });

    it("refuses the same id twice", async () => {
      await inRollback(async (trx) => {
        const admin = await fresh(trx);
        const [first] = await draftOf(trx);
        if (!first) throw new Error("no steps");
        const result = await send(trx, admin.id, [
          first,
          { ...first, featureName: "Other" },
        ]);
        expect(result).toEqual({
          ok: false,
          error: { kind: "duplicate_step" },
        });
      });
    });

    it("refuses a seed key that is not in the file", async () => {
      await inRollback(async (trx) => {
        const admin = await fresh(trx);
        const draft = await draftOf(trx);
        const result = await send(trx, admin.id, [
          ...draft,
          newStep("X", { seedKey: "not-a-key" }),
        ]);
        expect(result).toEqual({ ok: false, error: { kind: "bad_seed_key" } });
      });
    });

    it("refuses a seed key sent with an existing row", async () => {
      await inRollback(async (trx) => {
        const admin = await fresh(trx);
        const [first, ...rest] = await draftOf(trx);
        if (!first) throw new Error("no steps");
        const result = await send(trx, admin.id, [
          { ...first, seedKey: "ssids" },
          ...rest,
        ]);
        expect(result).toEqual({ ok: false, error: { kind: "bad_seed_key" } });
      });
    });

    it("refuses a seed key already used by a kept row, and one used twice", async () => {
      await inRollback(async (trx) => {
        const admin = await fresh(trx);
        const draft = await draftOf(trx);
        const used = await send(trx, admin.id, [
          ...draft,
          newStep("X", { seedKey: "ssids" }),
        ]);
        expect(used).toEqual({ ok: false, error: { kind: "duplicate_step" } });
        const kept = draft.filter((d) => d.featureName !== "SSIDs");
        const twice = await send(trx, admin.id, [
          ...kept,
          newStep("X", { seedKey: "ssids" }),
          newStep("Y", { seedKey: "ssids" }),
        ]);
        expect(twice).toEqual({ ok: false, error: { kind: "duplicate_step" } });
      });
    });

    it("AC-26: re-adds a removed starting step, with its seed key", async () => {
      await inRollback(async (trx) => {
        const admin = await fresh(trx);
        const draft = await draftOf(trx);
        const ssids = draft.find((d) => d.featureName === "SSIDs");
        if (!ssids) throw new Error("no SSIDs step");
        const removed = await send(
          trx,
          admin.id,
          draft.filter((d) => d !== ssids),
        );
        expect(removed.ok).toBe(true);
        const readded = await savePortalReset(
          asConn(trx),
          {
            expectedVersion: 2,
            abortEmail: "",
            mode: "off",
            steps: [
              ...(await draftOf(trx)),
              { ...ssids, id: undefined, seedKey: "ssids" },
            ],
          },
          admin.id,
        );
        expect(readded.ok).toBe(true);
        const row = await trx
          .selectFrom("portal_reset_steps")
          .select("seed_key")
          .where("seed_key", "=", "ssids")
          .execute();
        expect(row).toHaveLength(1);
      });
    });

    it("lets a Save remove a starting row and add it back from the file at once", async () => {
      await inRollback(async (trx) => {
        const admin = await fresh(trx);
        const draft = await draftOf(trx);
        const ssids = draft.find((d) => d.featureName === "SSIDs");
        if (!ssids) throw new Error("no SSIDs step");
        const result = await send(trx, admin.id, [
          ...draft.filter((d) => d !== ssids),
          { ...ssids, id: undefined, seedKey: "ssids" },
        ]);
        expect(result.ok).toBe(true);
      });
    });
  });

  describe("AC-12: the audit rows", () => {
    it("writes one row per change, in the same transaction, with plain summaries", async () => {
      await inRollback(async (trx) => {
        const admin = await fresh(trx);
        const [a, b, c, ...rest] = await draftOf(trx);
        if (!a || !b || !c) throw new Error("no steps");
        const result = await send(
          trx,
          admin.id,
          [
            c,
            { ...a, enabled: false },
            { ...b, note: "careful" },
            newStep("Extra"),
            ...rest,
          ],
          { abortEmail: "ops@example.com", mode: "dry_run" },
        );
        expect(result.ok).toBe(true);
        const rows = await audits(trx);
        const summaries = rows.map((r) => r.summary).sort();
        expect(summaries).toEqual(
          [
            "Added step Extra at 4",
            `Disabled step ${a.featureName}`,
            `Updated step ${b.featureName}`,
            "Reordered 3 steps",
            "Abort email set",
            "Mode changed from off to dry run",
            "Saved, version 1 to 2",
          ].sort(),
        );
        rows.forEach((r) => expect(r.actor_user_id).toBe(admin.id));
        const saved = rows.find((r) => r.action === "portal_reset.saved");
        expect(saved).toMatchObject({
          target_type: "portal_reset_settings",
          target_id: "settings",
        });
        expect(saved?.metadata).toMatchObject({
          version: { from: 1, to: 2 },
          steps: 14,
        });
        const updated = rows.find(
          (r) =>
            r.action === "portal_reset.step_updated" && r.target_id === b.id,
        );
        expect(updated?.target_type).toBe("portal_reset_step");
        expect(updated?.metadata).toEqual({
          note: { from: b.note, to: "careful" },
        });
      });
    });

    it("holds the full before and after definition of a changed step", async () => {
      await inRollback(async (trx) => {
        const admin = await fresh(trx);
        const [a, ...rest] = await draftOf(trx);
        if (!a) throw new Error("no steps");
        await send(trx, admin.id, [{ ...a, definition: wait(9) }, ...rest]);
        const row = (await audits(trx)).find(
          (r) => r.action === "portal_reset.step_updated",
        );
        expect(row?.metadata).toEqual({
          definition: { from: a.definition, to: wait(9) },
        });
      });
    });

    it("writes a removed step's name and definition", async () => {
      await inRollback(async (trx) => {
        const admin = await fresh(trx);
        const [a, ...rest] = await draftOf(trx);
        if (!a) throw new Error("no steps");
        await send(trx, admin.id, rest);
        const row = (await audits(trx)).find(
          (r) => r.action === "portal_reset.step_removed",
        );
        expect(row).toMatchObject({
          target_id: a.id,
          summary: `Removed step ${a.featureName}`,
        });
        expect(row?.metadata).toEqual({
          featureName: a.featureName,
          definition: a.definition,
        });
      });
    });

    it("never holds the email address, only that it changed and its domain", async () => {
      await inRollback(async (trx) => {
        const admin = await fresh(trx);
        const draft = await draftOf(trx);
        await send(trx, admin.id, draft, {
          abortEmail: "private.name@example.com",
        });
        const rows = await audits(trx);
        expect(JSON.stringify(rows)).not.toContain("private.name");
        const row = rows.find((r) => r.action === "portal_reset.email_changed");
        expect(row?.metadata).toEqual({ change: "set", domain: "example.com" });
      });
    });

    it("sets mode_changed_at only when the mode changes", async () => {
      await inRollback(async (trx) => {
        const admin = await fresh(trx);
        const draft = await draftOf(trx);
        await send(trx, admin.id, draft, { abortEmail: "a@example.com" });
        expect((await settings(trx)).mode_changed_at).toBeNull();
        await savePortalReset(
          asConn(trx),
          {
            expectedVersion: 2,
            abortEmail: "a@example.com",
            mode: "live",
            steps: draft,
          },
          admin.id,
        );
        expect((await settings(trx)).mode_changed_at).not.toBeNull();
      });
    });
  });
});
