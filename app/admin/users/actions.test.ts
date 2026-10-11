import { sql, type Kysely } from "kysely";
import { describe, expect, it, vi } from "vitest";
import type { CoreApi } from "@/server/authentik/client";
import type { DB } from "@/server/db/types";

class Redirect extends Error {
  constructor(readonly to: string) {
    super(to);
  }
}

const ctx = vi.hoisted(() => ({
  conn: undefined as Kysely<DB> | undefined,
  authUserId: undefined as string | undefined,
  api: undefined as CoreApi | undefined,
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Redirect(to);
  },
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/server/auth", () => ({
  auth: () => ({
    api: {
      getSession: async () =>
        ctx.authUserId
          ? {
              user: { id: ctx.authUserId },
              session: { id: "s", expiresAt: new Date(Date.now() + 60_000) },
            }
          : null,
    },
  }),
}));
vi.mock("@/server/env", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  adminEntryPath: () => "/l0gin",
}));
vi.mock("@/server/db", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/db")>();
  return { ...real, db: () => ctx.conn ?? real.db() };
});
vi.mock("@/server/authentik/client", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("@/server/authentik/client")>();
  return {
    ...real,
    authentik: () => {
      if (!ctx.api) throw new Error("no fake Authentik for this test");
      return ctx.api;
    },
  };
});

const {
  cancelBookingAdminAction,
  checkDeactivate,
  createLearnerAction,
  deactivateLearnerAction,
  reactivateLearnerAction,
  resendSetPasswordAdminAction,
  setAdminTimezoneAction,
  updateLearnerAction,
} = await import("./actions");
const { fakeAuthentik, fakeLearner } =
  await import("@/server/authentik/testing");
const {
  asConn,
  hasDb,
  inRollback,
  makeAuthUser,
  makeTestbed,
  makeType,
  makeUser,
  slot,
} = await import("@/server/db/testing");

const IDLE = { kind: "idle" } as const;
const unique = () => crypto.randomUUID().slice(0, 8);

const learnerForm = (over: Record<string, string> = {}) => {
  const f = new FormData();
  const values = {
    name: "Priya Shah",
    company: "Concordia University",
    email: `priya-${unique()}@x.test`,
    timezone: "America/Toronto",
    ...over,
  };
  Object.entries(values).forEach(([k, v]) => f.set(k, v));
  return f;
};

const redirectOf = async (run: () => Promise<unknown>) => {
  const thrown = await run().catch((e: unknown) => e);
  expect(thrown).toBeInstanceOf(Redirect);
  return (thrown as Redirect).to;
};

// Runs `body` as a fresh admin, learner, or anonymous caller; returns the
// caller's users row id (undefined when anonymous).
const as = (
  who: "admin" | "learner" | "anonymous",
  body: (trx: Kysely<DB>, me: string | undefined) => Promise<void>,
) =>
  inRollback(async (trx) => {
    ctx.conn = asConn(trx);
    try {
      let me: string | undefined;
      if (who !== "anonymous") {
        const authId = await makeAuthUser(trx, who === "admin" ? 9301 : 9302);
        const row = await makeUser(trx, {
          auth_user_id: authId,
          timezone: "UTC",
          ...(who === "admin" ? { role: "admin", company: null } : {}),
        });
        ctx.authUserId = authId;
        me = row.id;
      }
      await body(trx, me);
    } finally {
      ctx.conn = undefined;
      ctx.authUserId = undefined;
      ctx.api = undefined;
    }
  });

// A listed learner with a live Upcoming booking.
async function learnerWithBooking(trx: Kysely<DB>, pk: number) {
  const email = `pat-${unique()}@x.test`;
  const learner = await makeUser(trx, {
    name: "Pat Lee",
    email,
    authentik_user_pk: pk,
    set_password_pending: true,
  });
  const type = await makeType(trx);
  const testbed = await makeTestbed(trx, type.id);
  const booking = await trx
    .insertInto("bookings")
    .values({
      user_id: learner.id,
      testbed_id: testbed.id,
      testbed_type_id: type.id,
      starts_at: slot(48),
      ends_at: slot(50),
      status: "confirmed",
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return {
    learner,
    booking,
    account: fakeLearner(pk, { email, username: email }),
  };
}

// covers: AC-14
describe.skipIf(!hasDb)(
  "users actions require an admin (spec 0008 AC-14)",
  () => {
    it.each([
      ["anonymous", "/l0gin"],
      ["learner", "/auth/error?reason=not_authorized"],
    ] as const)("sends a %s caller to %s and writes nothing", (who, to) =>
      as(who, async (trx, me) => {
        const { learner, booking, account } = await learnerWithBooking(
          trx,
          9310,
        );
        const ak = fakeAuthentik([account]);
        ctx.api = ak.api;
        const email = `blocked-${unique()}@x.test`;

        const calls: readonly (() => Promise<unknown>)[] = [
          () => createLearnerAction(IDLE, learnerForm({ email })),
          () =>
            updateLearnerAction(
              learner.id,
              IDLE,
              learnerForm({ name: "Changed" }),
            ),
          () => resendSetPasswordAdminAction(learner.id),
          () => checkDeactivate(learner.id),
          () => deactivateLearnerAction(learner.id),
          () => reactivateLearnerAction(learner.id),
          () => cancelBookingAdminAction(booking.id, booking.version),
          () => setAdminTimezoneAction("Europe/Paris"),
        ];
        for (const call of calls) expect(await redirectOf(call)).toBe(to);

        expect(ak.writes).toEqual([]);
        expect(
          await trx
            .selectFrom("users")
            .select("id")
            .where("email", "=", email)
            .execute(),
        ).toEqual([]);
        expect(
          await trx
            .selectFrom("users")
            .select(["name", "status"])
            .where("id", "=", learner.id)
            .executeTakeFirstOrThrow(),
        ).toEqual({ name: "Pat Lee", status: "active" });
        expect(
          (
            await trx
              .selectFrom("bookings")
              .select("status")
              .where("id", "=", booking.id)
              .executeTakeFirstOrThrow()
          ).status,
        ).toBe("confirmed");
        const ids = [learner.id, booking.id, ...(me ? [me] : [])];
        expect(
          await trx
            .selectFrom("audit_events")
            .select("action")
            .where("target_id", "in", ids)
            .execute(),
        ).toEqual([]);
        if (me)
          expect(
            (
              await trx
                .selectFrom("users")
                .select("timezone")
                .where("id", "=", me)
                .executeTakeFirstOrThrow()
            ).timezone,
          ).toBe("UTC");
      }),
    );
  },
);

// covers: AC-4, AC-5, AC-6, AC-7, AC-8, AC-9, AC-10
describe.skipIf(!hasDb)("users actions for an admin (spec 0008)", () => {
  it("adds a learner, then links to them on a second add of the same email", () =>
    as("admin", async () => {
      ctx.api = fakeAuthentik([]).api;
      const email = `priya-${unique()}@x.test`;
      expect(await createLearnerAction(IDLE, learnerForm({ email }))).toEqual({
        kind: "saved",
        message: "Added Priya Shah.",
      });

      const again = await createLearnerAction(IDLE, learnerForm({ email }));
      expect(again).toMatchObject({
        kind: "error",
        fields: { email: "A user with this email already exists." },
        link: { label: "View user" },
      });
    }));

  it("returns field errors for bad input", () =>
    as("admin", async () => {
      expect(
        await createLearnerAction(
          IDLE,
          learnerForm({ name: " ", email: "nope", timezone: "Mars/Base" }),
        ),
      ).toEqual({
        kind: "error",
        fields: {
          name: "Enter the full name.",
          email: "Enter a valid email address.",
          timezone: "Choose a timezone from the list.",
        },
      });
    }));

  it("edits a learner, and says a bad id is gone", () =>
    as("admin", async (trx) => {
      const { learner, account } = await learnerWithBooking(trx, 9311);
      ctx.api = fakeAuthentik([account]).api;
      expect(
        await updateLearnerAction(
          learner.id,
          IDLE,
          learnerForm({ name: "Pat Morgan", email: learner.email }),
        ),
      ).toEqual({ kind: "saved", message: "Updated Pat Morgan." });
      expect(
        await updateLearnerAction("not-a-uuid", IDLE, learnerForm()),
      ).toEqual({
        kind: "error",
        message: "This user no longer exists.",
        fields: {},
      });
    }));

  it("queues a resend and returns the toast text", () =>
    as("admin", async (trx) => {
      const { learner } = await learnerWithBooking(trx, 9312);
      expect(await resendSetPasswordAdminAction(learner.id)).toEqual({
        ok: true,
        value: `Set password email queued for ${learner.email}.`,
      });
      expect(await resendSetPasswordAdminAction("not-a-uuid")).toEqual({
        ok: false,
        error: "not_eligible",
      });
    }));

  it("previews, deactivates, and reactivates, mapping a missing account", () =>
    as("admin", async (trx) => {
      const { learner, account } = await learnerWithBooking(trx, 9313);
      ctx.api = fakeAuthentik([account]).api;
      const preview = await checkDeactivate(learner.id);
      expect(preview.ok && preview.value).toHaveLength(1);
      expect(await checkDeactivate("not-a-uuid")).toEqual({
        ok: true,
        value: [],
      });

      expect(await deactivateLearnerAction(learner.id)).toEqual({
        ok: true,
        value: { cancelled: 1 },
      });
      ctx.api = fakeAuthentik([]).api;
      expect(await reactivateLearnerAction(learner.id)).toEqual({
        ok: false,
        error: "authentik_missing",
      });
      expect(await reactivateLearnerAction(crypto.randomUUID())).toEqual({
        ok: false,
        error: "not_found",
      });
    }));

  it("cancels a booking once, then reports it changed", () =>
    as("admin", async (trx) => {
      const { booking } = await learnerWithBooking(trx, 9314);
      expect(
        await cancelBookingAdminAction(booking.id, booking.version),
      ).toEqual({ ok: true, value: undefined });
      expect(
        await cancelBookingAdminAction(booking.id, booking.version),
      ).toEqual({ ok: false, error: "stale" });
      expect(await cancelBookingAdminAction("not-a-uuid", 1)).toEqual({
        ok: false,
        error: "stale",
      });
    }));

  it("stores the admin's browser zone once", () =>
    as("admin", async (trx, me) => {
      await setAdminTimezoneAction("Europe/Paris");
      await setAdminTimezoneAction("not a zone");
      expect(
        (
          await trx
            .selectFrom("users")
            .select("timezone")
            .where("id", "=", me ?? "")
            .executeTakeFirstOrThrow()
        ).timezone,
      ).toBe("Europe/Paris");
    }));
});

// covers: AC-5, AC-6, AC-8, AC-9, AC-10, AC-14 (what each refusal tells the admin)
describe.skipIf(!hasDb)(
  "users actions turn refusals into messages (spec 0008)",
  () => {
    const usersWithEmail = (trx: Kysely<DB>, email: string) =>
      trx
        .selectFrom("users")
        .select("id")
        .where(sql<string>`lower(email)`, "=", email.toLowerCase())
        .execute();

    it("refuses an admin's email on the email field, adding no row", () =>
      as("admin", async (trx, me) => {
        ctx.api = fakeAuthentik([]).api;
        const admin = await trx
          .selectFrom("users")
          .select("email")
          .where("id", "=", me ?? "")
          .executeTakeFirstOrThrow();
        expect(
          await createLearnerAction(
            IDLE,
            learnerForm({ email: admin.email.toUpperCase() }),
          ),
        ).toEqual({
          kind: "error",
          fields: { email: "This email can't be used for a learner account." },
        });
        expect(await usersWithEmail(trx, admin.email)).toHaveLength(1);
      }));

    it("says a row with no pk yet is being set up, with no link", () =>
      as("admin", async (trx) => {
        ctx.api = fakeAuthentik([]).api;
        const pending = await makeUser(trx, {
          email: `half-${unique()}@x.test`,
        });
        expect(
          await createLearnerAction(
            IDLE,
            learnerForm({ email: pending.email }),
          ),
        ).toEqual({
          kind: "error",
          fields: {
            email:
              "A user with this email is being set up. Try again in a minute.",
          },
        });
      }));

    it("shows the unavailable message when Authentik is down, adding no row", () =>
      as("admin", async (trx) => {
        ctx.api = fakeAuthentik([], { down: true }).api;
        const email = `down-${unique()}@x.test`;
        expect(await createLearnerAction(IDLE, learnerForm({ email }))).toEqual(
          {
            kind: "error",
            message:
              "Authentik is unavailable. Nothing was changed, try again.",
            fields: {},
          },
        );
        expect(await usersWithEmail(trx, email)).toEqual([]);
      }));

    it("refuses an email change after sign in on the email field", () =>
      as("admin", async (trx) => {
        const { learner, account } = await learnerWithBooking(trx, 9320);
        await trx
          .updateTable("users")
          .set({ set_password_pending: false })
          .where("id", "=", learner.id)
          .execute();
        const ak = fakeAuthentik([account]);
        ctx.api = ak.api;
        expect(
          await updateLearnerAction(
            learner.id,
            IDLE,
            learnerForm({
              name: learner.name,
              email: `new-${unique()}@x.test`,
            }),
          ),
        ).toEqual({
          kind: "error",
          fields: {
            email: "This email can't change after the learner signs in.",
          },
        });
        expect(ak.writes).toEqual([]);
      }));

    it("leaves the row unchanged and says so when Authentik is down on edit", () =>
      as("admin", async (trx) => {
        const { learner, account } = await learnerWithBooking(trx, 9321);
        ctx.api = fakeAuthentik([account], { down: true }).api;
        expect(
          await updateLearnerAction(
            learner.id,
            IDLE,
            learnerForm({ name: "Pat Morgan", email: learner.email }),
          ),
        ).toEqual({
          kind: "error",
          message: "Authentik is unavailable. Nothing was changed, try again.",
          fields: {},
        });
        const after = await trx
          .selectFrom("users")
          .select("name")
          .where("id", "=", learner.id)
          .executeTakeFirstOrThrow();
        expect(after.name).toBe("Pat Lee");
      }));

    it("refuses to deactivate or reactivate an admin row, with no Authentik write", () =>
      as("admin", async (trx) => {
        const other = await makeUser(trx, {
          role: "admin",
          company: null,
          authentik_user_pk: 9322,
        });
        const ak = fakeAuthentik([]);
        ctx.api = ak.api;
        expect(await deactivateLearnerAction(other.id)).toEqual({
          ok: false,
          error: "refused",
        });
        expect(await reactivateLearnerAction(other.id)).toEqual({
          ok: false,
          error: "refused",
        });
        expect(ak.writes).toEqual([]);
        const after = await trx
          .selectFrom("users")
          .select("status")
          .where("id", "=", other.id)
          .executeTakeFirstOrThrow();
        expect(after.status).toBe("active");
      }));

    it("refuses to deactivate while a booking is being set up", () =>
      as("admin", async (trx) => {
        const { learner, booking, account } = await learnerWithBooking(
          trx,
          9323,
        );
        await trx
          .updateTable("bookings")
          .set({ status: "provisioning" })
          .where("id", "=", booking.id)
          .execute();
        const ak = fakeAuthentik([account]);
        ctx.api = ak.api;
        expect(await deactivateLearnerAction(learner.id)).toEqual({
          ok: false,
          error: "booking_pending",
        });
        expect(ak.writes).toEqual([]);
      }));

    // Spec 0008 key invariant: rows with no Authentik pk are never shown,
    // edited, or deactivated from the console.
    it("treats a learner with no pk as not found when deactivating", () =>
      as("admin", async (trx) => {
        const pending = await makeUser(trx, {
          email: `half-${unique()}@x.test`,
        });
        ctx.api = fakeAuthentik([]).api;
        expect(await deactivateLearnerAction(pending.id)).toEqual({
          ok: false,
          error: "not_found",
        });
        const after = await trx
          .selectFrom("users")
          .select("status")
          .where("id", "=", pending.id)
          .executeTakeFirstOrThrow();
        expect(after.status).toBe("active");
      }));

    it("calls a version that is not a whole number stale, changing nothing", () =>
      as("admin", async (trx) => {
        const { booking } = await learnerWithBooking(trx, 9324);
        expect(await cancelBookingAdminAction(booking.id, 1.5)).toEqual({
          ok: false,
          error: "stale",
        });
        const after = await trx
          .selectFrom("bookings")
          .select("status")
          .where("id", "=", booking.id)
          .executeTakeFirstOrThrow();
        expect(after.status).toBe("confirmed");
      }));
  },
);
