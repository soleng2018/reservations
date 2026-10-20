import { randomBytes } from "node:crypto";
import { sql, type Kysely } from "kysely";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { TestbedInput } from "@/lib/catalog-input";
import {
  fakeAuthentik,
  fakeGroup,
  fakeLearner,
} from "@/server/authentik/testing";
import { deactivateLearner } from "@/server/authentik/learners";
import { createApiKey, updateApiKey } from "@/server/catalog/api-keys";
import {
  createTestbed,
  deleteTestbed,
  updateTestbed,
} from "@/server/catalog/testbeds";
import {
  createTestbedType,
  deleteTestbedType,
  updateTestbedType,
} from "@/server/catalog/testbed-types";
import type { Keyring } from "@/server/crypto/secrets";
import { db } from "@/server/db";
import {
  asConn,
  hasDb,
  inRollback,
  makeAuthUser,
  makeTestbed,
  makeType,
  makeUser,
  slot,
} from "@/server/db/testing";
import type { DB } from "@/server/db/types";
import { cancelBookingByAdmin } from "@/server/users/learners";
import { reconcileAccess } from "@/server/worker/reconcile";
import { teardownDeletedTestbeds } from "@/server/worker/teardown";

// Spec 0016 AC-12: each action the scope names writes one entry with its
// actor, action, target, and time, through the real server function. Admin
// actions carry the admin's id; worker actions carry null.

const unique = () => crypto.randomUUID().slice(0, 8);

// pk numbers high enough never to meet a real Authentik pk in the shared DB.
const PK = 900_000 + Math.floor(Math.random() * 90_000);

const KEYRING: Keyring = {
  activeKeyId: "ktest",
  keys: new Map([["ktest", randomBytes(32)]]),
};

const OFF = async () => ({ kind: "off" }) as const;

// The one entry for this action and target, with its time checked against
// the test's now(): set, and not after it.
const entryFor = async (trx: Kysely<DB>, action: string, targetId: string) =>
  trx
    .selectFrom("audit_events")
    .select([
      "actor_user_id",
      "action",
      "target_type",
      "target_id",
      sql<boolean>`created_at is not null and created_at <= now()`.as("timed"),
    ])
    .where("action", "=", action)
    .where("target_id", "=", targetId)
    .execute();

const expected = (
  actor: string | null,
  action: string,
  targetType: string,
  targetId: string,
) => [
  {
    actor_user_id: actor,
    action,
    target_type: targetType,
    target_id: targetId,
    timed: true,
  },
];

const bookingFor = async (
  trx: Kysely<DB>,
  userId: string,
  testbedId: string,
  typeId: string,
  from: number,
  to: number,
) =>
  trx
    .insertInto("bookings")
    .values({
      user_id: userId,
      testbed_id: testbedId,
      testbed_type_id: typeId,
      starts_at: slot(from),
      ends_at: slot(to),
      status: "confirmed",
    })
    .returningAll()
    .executeTakeFirstOrThrow();

afterAll(() => (hasDb ? db().destroy() : undefined));

afterEach(() => {
  vi.restoreAllMocks();
});

// The worker steps read every testbed in the shared database; the fake
// Authentik knows only this test's groups, so the rest log and move on.
const quiet = () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
};

describe.skipIf(!hasDb)("audit coverage (AC-12)", () => {
  it("records API key creation and secret replacement", () =>
    inRollback(async (trx) => {
      const admin = await makeUser(trx, { role: "admin" });
      const fields = {
        name: `Okta ${unique()}`,
        type: "IDP",
        baseUrl: "https://acme.okta.example",
        secret: "first-secret",
      } as const;
      const created = await createApiKey(
        asConn(trx),
        KEYRING,
        fields,
        admin.id,
      );
      if (!created.ok) throw new Error("expected a create");
      const id = created.value.id;
      expect(await entryFor(trx, "api_key.created", id)).toEqual(
        expected(admin.id, "api_key.created", "api_key", id),
      );

      const replaced = await updateApiKey(
        asConn(trx),
        KEYRING,
        id,
        { ...fields, secret: "second-secret" },
        admin.id,
      );
      expect(replaced.ok).toBe(true);
      expect(await entryFor(trx, "api_key.secret_replaced", id)).toEqual(
        expected(admin.id, "api_key.secret_replaced", "api_key", id),
      );
    }));

  it("records testbed type creation, edit, and deletion", () =>
    inRollback(async (trx) => {
      const admin = await makeUser(trx, { role: "admin" });
      const input = {
        name: `Type ${unique()}`,
        durationValue: 2,
        durationUnit: "hours",
      } as const;
      const created = await createTestbedType(asConn(trx), input, admin.id);
      if (!created.ok) throw new Error(created.error);
      const id = created.value.id;
      expect(await entryFor(trx, "testbed_type.created", id)).toEqual(
        expected(admin.id, "testbed_type.created", "testbed_type", id),
      );

      expect(
        (
          await updateTestbedType(
            asConn(trx),
            id,
            { ...input, durationValue: 3 },
            admin.id,
          )
        ).ok,
      ).toBe(true);
      expect(await entryFor(trx, "testbed_type.updated", id)).toEqual(
        expected(admin.id, "testbed_type.updated", "testbed_type", id),
      );

      expect((await deleteTestbedType(asConn(trx), id, admin.id)).ok).toBe(
        true,
      );
      expect(await entryFor(trx, "testbed_type.deleted", id)).toEqual(
        expected(admin.id, "testbed_type.deleted", "testbed_type", id),
      );
    }));

  it("records a testbed's creation with its access group, edit, deletion, and group teardown", () =>
    inRollback(async (trx) => {
      quiet();
      const admin = await makeUser(trx, { role: "admin" });
      const type = await makeType(trx);
      const input: TestbedInput = {
        name: `Lab ${unique()}`,
        testbedTypeId: type.id,
        idpApiKeyId: null,
        portalUrl: "https://portal.example.test",
        lmsUrl: "https://lms.example.test",
        clients: [
          {
            kind: "wireless",
            name: "Air 1",
            url: "https://a1.example.test",
            osUsername: null,
            osPassword: null,
          },
        ],
      };
      const ak = fakeAuthentik([]);
      const created = await createTestbed(ak.api, asConn(trx), input, admin.id);
      if (!created.ok) throw new Error(JSON.stringify(created.error));
      const id = created.value.id;
      const { authentik_group_pk: groupPk } = await trx
        .selectFrom("testbeds")
        .select("authentik_group_pk")
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
      if (groupPk === null) throw new Error("expected a group");
      expect(await entryFor(trx, "testbed.created", id)).toEqual(
        expected(admin.id, "testbed.created", "testbed", id),
      );
      expect(await entryFor(trx, "authentik_group.created", groupPk)).toEqual(
        expected(
          admin.id,
          "authentik_group.created",
          "authentik_group",
          groupPk,
        ),
      );

      expect(
        (
          await updateTestbed(
            asConn(trx),
            id,
            { ...input, name: `${input.name} v2` },
            admin.id,
          )
        ).ok,
      ).toBe(true);
      expect(await entryFor(trx, "testbed.updated", id)).toEqual(
        expected(admin.id, "testbed.updated", "testbed", id),
      );

      expect((await deleteTestbed(asConn(trx), id, admin.id)).ok).toBe(true);
      expect(await entryFor(trx, "testbed.deleted", id)).toEqual(
        expected(admin.id, "testbed.deleted", "testbed", id),
      );

      // The worker tears the emptied group down, as the system.
      await teardownDeletedTestbeds(ak.api, asConn(trx));
      expect(await entryFor(trx, "authentik_group.deleted", groupPk)).toEqual(
        expected(null, "authentik_group.deleted", "authentik_group", groupPk),
      );
    }));

  it("records access grants and revokes by the reconciler, as the system", () =>
    inRollback(async (trx) => {
      quiet();
      const type = await makeType(trx);
      const pk = crypto.randomUUID();
      const testbed = await makeTestbed(trx, type.id, {
        authentik_group_pk: pk,
      });
      const current = await makeUser(trx, { authentik_user_pk: PK + 1 });
      const booking = await bookingFor(
        trx,
        current.id,
        testbed.id,
        type.id,
        -1,
        2,
      );
      const ended = await makeUser(trx, { authentik_user_pk: PK + 2 });
      const ak = fakeAuthentik(
        [fakeLearner(PK + 1), fakeLearner(PK + 2, { groups: [pk] })],
        { groups: [fakeGroup(pk, `pod-${testbed.slug}`)] },
      );

      await reconcileAccess(ak.api, asConn(trx), OFF);

      expect(await entryFor(trx, "access.granted", booking.id)).toEqual(
        expected(null, "access.granted", "booking", booking.id),
      );
      expect(await entryFor(trx, "access.revoked", ended.id)).toEqual(
        expected(null, "access.revoked", "user", ended.id),
      );
    }));

  it("records a deactivation and the booking it cancels, as the admin", () =>
    inRollback(async (trx) => {
      const admin = await makeUser(trx, { role: "admin" });
      const authUserId = await makeAuthUser(trx, PK + 3);
      const learner = await makeUser(trx, {
        authentik_user_pk: PK + 3,
        auth_user_id: authUserId,
      });
      const type = await makeType(trx);
      const testbed = await makeTestbed(trx, type.id);
      const live = await bookingFor(
        trx,
        learner.id,
        testbed.id,
        type.id,
        48,
        50,
      );
      const ak = fakeAuthentik([fakeLearner(PK + 3)]);

      expect(
        await deactivateLearner(ak.api, asConn(trx), learner.id, admin.id),
      ).toEqual({ ok: true, value: { cancelled: 1 } });
      expect(await entryFor(trx, "user.deactivated", learner.id)).toEqual(
        expected(admin.id, "user.deactivated", "user", learner.id),
      );
      expect(await entryFor(trx, "booking.cancelled", live.id)).toEqual(
        expected(admin.id, "booking.cancelled", "booking", live.id),
      );
    }));

  it("records a booking an admin cancels from the detail page", () =>
    inRollback(async (trx) => {
      const admin = await makeUser(trx, { role: "admin" });
      const learner = await makeUser(trx, { authentik_user_pk: PK + 4 });
      const type = await makeType(trx);
      const testbed = await makeTestbed(trx, type.id);
      const live = await bookingFor(
        trx,
        learner.id,
        testbed.id,
        type.id,
        48,
        50,
      );

      expect(
        await cancelBookingByAdmin(
          asConn(trx),
          live.id,
          live.version,
          admin.id,
        ),
      ).toEqual({ ok: true, value: undefined });
      expect(await entryFor(trx, "booking.cancelled", live.id)).toEqual(
        expected(admin.id, "booking.cancelled", "booking", live.id),
      );
    }));
});
