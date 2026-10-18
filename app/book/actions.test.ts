import type { Kysely } from "kysely";
import { describe, expect, it, vi } from "vitest";
import type { CoreApi } from "@/server/authentik/client";
import type { DB } from "@/server/db/types";

const ctx = vi.hoisted(() => ({
  conn: undefined as Kysely<DB> | undefined,
  api: undefined as CoreApi | undefined,
  ip: "203.0.113.7",
  human: true,
  verified: 0,
  // What currentSession() returns (spec 0011 AC-13); undefined is signed out.
  session: undefined as
    | {
        readonly user: {
          readonly id: string;
          readonly role: string;
          readonly status: string;
        };
      }
    | undefined,
}));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "cf-connecting-ip": ctx.ip }),
}));
vi.mock("@/server/env", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  trustProxyHeaders: () => true,
}));
vi.mock("@/server/turnstile", () => ({
  verifyTurnstile: async () => {
    ctx.verified += 1;
    return ctx.human
      ? { ok: true, value: undefined }
      : { ok: false, error: "failed" };
  },
}));
vi.mock("@/server/authentik/client", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  authentik: () => {
    if (!ctx.api) throw new Error("no fake Authentik set");
    return ctx.api;
  },
}));
vi.mock("@/server/auth/require", () => ({
  currentSession: async () => ctx.session,
}));
vi.mock("@/server/db", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/db")>();
  return { ...real, db: () => ctx.conn ?? real.db() };
});

const {
  bookAction,
  checkDetailsAction,
  loadStartsAction,
  previewTestbedAction,
} = await import("./actions");
const { asConn, hasDb, inRollback, makeTestbed, makeType, makeUser, slot } =
  await import("@/server/db/testing");
const { fakeAuthentik } = await import("@/server/authentik/testing");

const IDLE = { kind: "idle" } as const;
const LIMITED = { kind: "error", code: "limited", fields: {} } as const;

const uniqueIp = () => `198.51.100.${crypto.randomUUID()}`;

const form = (values: Record<string, string>) => {
  const f = new FormData();
  Object.entries(values).forEach(([k, v]) => f.set(k, v));
  return f;
};

async function setup(trx: Kysely<DB>) {
  const type = await makeType(trx, { duration_value: 2 });
  await makeTestbed(trx, type.id, { name: "aa bench" });
  const email = `dev-guest-${crypto.randomUUID().slice(0, 8)}@nile-test.invalid`;
  const values = {
    name: "Priya",
    company: "Acme",
    email,
    timezone: "America/New_York",
    testbedTypeId: type.id,
    startsAt: slot(24).toISOString(),
    "cf-turnstile-response": "token",
  };
  const bookings = () =>
    trx
      .selectFrom("bookings")
      .select("status")
      .where("testbed_type_id", "=", type.id)
      .execute();
  return { type, email, values, bookings };
}

const run = (body: (trx: Kysely<DB>) => Promise<void>) =>
  inRollback(async (trx) => {
    ctx.conn = asConn(trx);
    ctx.api = fakeAuthentik([]).api;
    ctx.ip = uniqueIp();
    ctx.human = true;
    ctx.verified = 0;
    ctx.session = undefined;
    try {
      await body(trx);
    } finally {
      ctx.conn = undefined;
      ctx.api = undefined;
    }
  });

// covers: AC-3, AC-4, AC-6, AC-7
describe.skipIf(!hasDb)("bookAction (AC-4, AC-6)", () => {
  it("books and returns the confirmation state", () =>
    run(async () => {
      const { type, values } = await setup(ctx.conn as Kysely<DB>);
      const state = await bookAction(IDLE, form(values));
      expect(state).toEqual({
        kind: "booked",
        typeName: type.name,
        testbedName: "aa bench",
        startsAt: values.startsAt,
        endsAt: new Date(
          new Date(values.startsAt).getTime() + 2 * 3_600_000,
        ).toISOString(),
        timezone: "America/New_York",
        newUser: true,
        access: null,
      });
    }));

  it("refuses the sixth attempt from one IP in 10 minutes, before Turnstile", () =>
    run(async (trx) => {
      const { values, bookings } = await setup(trx);
      const bad = { ...values, name: "" };
      for (let i = 0; i < 5; i++)
        expect((await bookAction(IDLE, form(bad))).kind).toBe("error");
      expect(ctx.verified).toBe(5);
      expect(await bookAction(IDLE, form(values))).toEqual(LIMITED);
      expect(ctx.verified).toBe(5);
      expect(await bookings()).toEqual([]);
    }));

  it("counts a failed Turnstile against the IP bucket and writes nothing", () =>
    run(async (trx) => {
      const { values, bookings } = await setup(trx);
      ctx.human = false;
      expect(await bookAction(IDLE, form(values))).toEqual(LIMITED);
      const bucket = await trx
        .selectFrom("rate_limits")
        .select("count")
        .where("bucket_key", "=", `book:ip:${ctx.ip}`)
        .execute();
      expect(bucket).toEqual([{ count: 1 }]);
      expect(await bookings()).toEqual([]);
    }));

  it("refuses the fourth attempt per email per hour", () =>
    run(async (trx) => {
      const { values, email, bookings } = await setup(trx);
      // Different IPs, same email in another case: the key is lowercased.
      // Each attempt parses (so it counts) and then fails on the start.
      for (let i = 0; i < 3; i++) {
        ctx.ip = uniqueIp();
        const stale = { startsAt: slot(0.5).toISOString() };
        expect(
          await bookAction(
            IDLE,
            form({ ...values, email: email.toUpperCase(), ...stale }),
          ),
        ).toMatchObject({ code: "slot_taken" });
      }
      ctx.ip = uniqueIp();
      expect(await bookAction(IDLE, form(values))).toEqual(LIMITED);
      expect(await bookings()).toEqual([]);
    }));

  it("returns field errors for bad input, without touching the email bucket", () =>
    run(async (trx) => {
      const { values } = await setup(trx);
      const state = await bookAction(
        IDLE,
        form({
          ...values,
          name: " ",
          company: "x".repeat(201),
          email: `${"a".repeat(250)}@x.test`,
          timezone: "Mars/Olympus",
        }),
      );
      expect(state).toEqual({
        kind: "error",
        code: "invalid",
        fields: {
          name: "Enter your name.",
          company: "Use at most 200 characters.",
          email: "Use at most 254 characters.",
          timezone: "Choose a timezone from the list.",
        },
      });
      const emailBuckets = await trx
        .selectFrom("rate_limits")
        .select("bucket_key")
        .where("bucket_key", "like", "book:email:%a@x.test")
        .execute();
      expect(emailBuckets).toEqual([]);
    }));

  it("says the time was taken for a start inside the lead time", () =>
    run(async (trx) => {
      const { values } = await setup(trx);
      expect(
        await bookAction(
          IDLE,
          form({ ...values, startsAt: slot(0.5).toISOString() }),
        ),
      ).toEqual({ kind: "error", code: "slot_taken", fields: {} });
    }));
});

// covers: spec 0004 AC-3, spec 0010 AC-4
describe.skipIf(!hasDb)("loadStartsAction (AC-3)", () => {
  it("lists ISO starts with the duration and the DB clock, and limits 60 calls per IP per 10 minutes", () =>
    run(async (trx) => {
      const { type } = await setup(trx);
      const first = await loadStartsAction(type.id);
      if (!("starts" in first)) throw new Error("limited too early");
      expect(first.starts.length).toBeGreaterThan(0);
      expect(first.starts[0]).toMatch(
        /^\d{4}-\d\d-\d\dT\d\d:(00|30):00\.000Z$/,
      );
      expect(first.durationMs).toBe(2 * 3_600_000);
      expect(new Date(first.now).getTime()).not.toBeNaN();
      // spec 0010: the window is 90 days, so the list reaches past 14.
      const last = new Date(first.starts.at(-1) ?? first.now).getTime();
      expect(last - new Date(first.now).getTime()).toBeGreaterThan(
        80 * 24 * 3_600_000,
      );
      await trx
        .updateTable("rate_limits")
        .set({ count: 60 })
        .where("bucket_key", "=", `starts:ip:${ctx.ip}`)
        .execute();
      expect(await loadStartsAction(type.id)).toEqual({ limited: true });
    }));

  it("gives an empty list for a bad or unknown type", () =>
    run(async () => {
      for (const id of ["not-a-uuid", crypto.randomUUID()]) {
        const result = await loadStartsAction(id);
        expect(result).toMatchObject({ starts: [], durationMs: 0 });
        expect("now" in result && typeof result.now).toBe("string");
      }
    }));
});

const details = (values: Record<string, string>) => ({
  name: values.name ?? "",
  company: values.company ?? "",
  email: values.email ?? "",
  timezone: values.timezone ?? "",
  testbedTypeId: values.testbedTypeId ?? "",
});

const bucket = (trx: Kysely<DB>, key: string) =>
  trx
    .selectFrom("rate_limits")
    .select("count")
    .where("bucket_key", "=", key)
    .execute();

// covers: spec 0010 AC-2, AC-3, AC-13
describe.skipIf(!hasDb)("checkDetailsAction (spec 0010 AC-2)", () => {
  it("answers ok for a new guest and a bookable type", () =>
    run(async (trx) => {
      const { values } = await setup(trx);
      expect(await checkDetailsAction(details(values))).toEqual({
        kind: "ok",
      });
    }));

  it("names the refusal, with no learner data", () =>
    run(async (trx) => {
      const { values, type } = await setup(trx);
      const user = await makeUser(trx, { email: values.email });
      await trx
        .insertInto("bookings")
        .values({
          user_id: user.id,
          testbed_id: (await makeTestbed(trx, type.id)).id,
          testbed_type_id: type.id,
          starts_at: slot(30),
          ends_at: slot(32),
          status: "confirmed",
        })
        .execute();
      const result = await checkDetailsAction(details(values));
      expect(result).toEqual({
        kind: "error",
        code: "has_live_booking",
        fields: {},
      });
      const text = JSON.stringify(result);
      expect(text).not.toContain(user.id);
      expect(text).not.toContain("Test Learner");
    }));

  it("returns field errors before the email bucket counts", () =>
    run(async (trx) => {
      const { values } = await setup(trx);
      const result = await checkDetailsAction(
        details({ ...values, name: " ", timezone: "Mars/Olympus" }),
      );
      expect(result).toEqual({
        kind: "error",
        code: "invalid",
        fields: {
          name: "Enter your name.",
          timezone: "Choose a timezone from the list.",
        },
      });
      expect(
        await bucket(trx, `details:email:${values.email.toLowerCase()}`),
      ).toEqual([]);
    }));

  // A public action takes whatever a caller posts.
  it("reads a non object input as every field missing", () =>
    run(async () => {
      const result = await checkDetailsAction(
        null as unknown as Parameters<typeof checkDetailsAction>[0],
      );
      expect(result).toMatchObject({ kind: "error", code: "invalid" });
      expect(
        Object.keys("fields" in result ? result.fields : {}).sort(),
      ).toEqual(["company", "email", "name", "testbedTypeId", "timezone"]);
    }));

  it("answers limited over the IP bucket before parsing or reading", () =>
    run(async (trx) => {
      const { values, type } = await setup(trx);
      const user = await makeUser(trx, { email: values.email });
      await trx
        .insertInto("bookings")
        .values({
          user_id: user.id,
          testbed_id: (await makeTestbed(trx, type.id)).id,
          testbed_type_id: type.id,
          starts_at: slot(30),
          ends_at: slot(32),
          status: "confirmed",
        })
        .execute();
      await checkDetailsAction(details({ ...values, name: "" }));
      await trx
        .updateTable("rate_limits")
        .set({ count: 20 })
        .where("bucket_key", "=", `details:ip:${ctx.ip}`)
        .execute();

      expect(await checkDetailsAction(details(values))).toEqual({
        kind: "error",
        code: "limited",
        fields: {},
      });
      expect(
        await bucket(trx, `details:email:${values.email.toLowerCase()}`),
      ).toEqual([]);
    }));

  it("limits 20 checks per IP per 10 minutes", () =>
    run(async (trx) => {
      const { values } = await setup(trx);
      for (let i = 0; i < 20; i++)
        expect(
          (await checkDetailsAction(details({ ...values, name: "" }))).kind,
        ).toBe("error");
      expect(await checkDetailsAction(details(values))).toEqual({
        kind: "error",
        code: "limited",
        fields: {},
      });
    }));

  it("fails open over 10 checks per email per hour, reading nothing", () =>
    run(async (trx) => {
      const { values, type } = await setup(trx);
      const user = await makeUser(trx, { email: values.email });
      await trx
        .insertInto("bookings")
        .values({
          user_id: user.id,
          testbed_id: (await makeTestbed(trx, type.id)).id,
          testbed_type_id: type.id,
          starts_at: slot(30),
          ends_at: slot(32),
          status: "confirmed",
        })
        .execute();
      for (let i = 0; i < 10; i++) {
        ctx.ip = uniqueIp();
        expect(
          await checkDetailsAction(
            details({ ...values, email: values.email.toUpperCase() }),
          ),
        ).toMatchObject({ code: "has_live_booking" });
      }
      ctx.ip = uniqueIp();
      expect(await checkDetailsAction(details(values))).toEqual({
        kind: "ok",
      });
    }));

  it("writes only rate limit rows", () =>
    run(async (trx) => {
      const { values, bookings } = await setup(trx);
      const users = () =>
        trx
          .selectFrom("users")
          .select("id")
          .where("email", "=", values.email)
          .execute();
      await checkDetailsAction(details(values));
      expect(await users()).toEqual([]);
      expect(await bookings()).toEqual([]);
      expect(await bucket(trx, `details:ip:${ctx.ip}`)).toEqual([{ count: 1 }]);
    }));
});

// covers: spec 0010 AC-7, AC-13
describe.skipIf(!hasDb)("previewTestbedAction (spec 0010 AC-7)", () => {
  it("names the testbed and the end, and nothing else", () =>
    run(async (trx) => {
      const { type, values } = await setup(trx);
      const result = await previewTestbedAction(type.id, values.startsAt);
      expect(result).toEqual({
        kind: "ok",
        testbedName: "aa bench",
        endsAt: new Date(
          new Date(values.startsAt).getTime() + 2 * 3_600_000,
        ).toISOString(),
      });
    }));

  it("reads bad input or a start inside the lead time as taken", () =>
    run(async (trx) => {
      const { type } = await setup(trx);
      expect(
        await previewTestbedAction("nope", slot(24).toISOString()),
      ).toEqual({ kind: "taken" });
      expect(await previewTestbedAction(type.id, "tomorrow")).toEqual({
        kind: "taken",
      });
      expect(
        await previewTestbedAction(type.id, slot(0.5).toISOString()),
      ).toEqual({ kind: "taken" });
    }));

  it("reads a busy testbed or a start past the horizon as taken", () =>
    run(async (trx) => {
      const { type, values } = await setup(trx);
      const testbed = await trx
        .selectFrom("testbeds")
        .select("id")
        .where("testbed_type_id", "=", type.id)
        .executeTakeFirstOrThrow();
      const user = await makeUser(trx);
      await trx
        .insertInto("bookings")
        .values({
          user_id: user.id,
          testbed_id: testbed.id,
          testbed_type_id: type.id,
          starts_at: new Date(values.startsAt),
          ends_at: new Date(new Date(values.startsAt).getTime() + 3_600_000),
          status: "confirmed",
        })
        .execute();
      expect(await previewTestbedAction(type.id, values.startsAt)).toEqual({
        kind: "taken",
      });
      expect(
        await previewTestbedAction(type.id, slot(24 * 91).toISOString()),
      ).toEqual({ kind: "taken" });
    }));

  // The preview is advice: it holds nothing (spec 0010 key invariants).
  it("writes only its rate limit row", () =>
    run(async (trx) => {
      const { type, values, bookings } = await setup(trx);
      const usersBefore = await trx
        .selectFrom("users")
        .select(({ fn }) => fn.countAll<string>().as("n"))
        .executeTakeFirstOrThrow();
      expect((await previewTestbedAction(type.id, values.startsAt)).kind).toBe(
        "ok",
      );
      expect(await bookings()).toEqual([]);
      expect(
        await trx
          .selectFrom("users")
          .select(({ fn }) => fn.countAll<string>().as("n"))
          .executeTakeFirstOrThrow(),
      ).toEqual(usersBefore);
      expect(await bucket(trx, `preview:ip:${ctx.ip}`)).toEqual([{ count: 1 }]);
    }));

  it("limits 60 previews per IP per 10 minutes", () =>
    run(async (trx) => {
      const { type, values } = await setup(trx);
      await previewTestbedAction(type.id, values.startsAt);
      await trx
        .updateTable("rate_limits")
        .set({ count: 60 })
        .where("bucket_key", "=", `preview:ip:${ctx.ip}`)
        .execute();
      expect(await previewTestbedAction(type.id, values.startsAt)).toEqual({
        kind: "limited",
      });
    }));
});

// Signs `user` in as currentSession() would see them.
const signIn = (user: { id: string; role: string; status: string }) => {
  ctx.session = {
    user: { id: user.id, role: user.role, status: user.status },
  };
};

const bookingsOf = (trx: Kysely<DB>, userId: string) =>
  trx
    .selectFrom("bookings")
    .select(["status", "starts_at"])
    .where("user_id", "=", userId)
    .execute();

// covers: spec 0011 AC-13
describe.skipIf(!hasDb)("signed in /book (spec 0011 AC-13)", () => {
  it("books as the session's account, whatever the form says", () =>
    run(async (trx) => {
      const { type, values } = await setup(trx);
      const learner = await makeUser(trx, {
        company: null,
        timezone: "Europe/Paris",
      });
      signIn(learner);
      const state = await bookAction(
        IDLE,
        form({
          ...values,
          name: "",
          company: "",
          email: "someone-else@nile-test.invalid",
          timezone: "Mars/Olympus",
          asAccount: "1",
        }),
      );
      expect(state).toMatchObject({
        kind: "booked",
        typeName: type.name,
        timezone: "Europe/Paris",
      });
      expect(await bookingsOf(trx, learner.id)).toHaveLength(1);
      const other = await trx
        .selectFrom("users")
        .select("id")
        .where("email", "=", "someone-else@nile-test.invalid")
        .execute();
      expect(other).toEqual([]);
      // The stored null company is kept.
      const row = await trx
        .selectFrom("users")
        .select("company")
        .where("id", "=", learner.id)
        .executeTakeFirstOrThrow();
      expect(row.company).toBeNull();
    }));

  it("checks Step 1 against the session's email and asks only for the type", () =>
    run(async (trx) => {
      const { values } = await setup(trx);
      const learner = await makeUser(trx);
      signIn(learner);
      expect(
        await checkDetailsAction(
          details({ ...values, name: "", email: "x" }),
          "1",
        ),
      ).toEqual({ kind: "ok" });
      expect(
        await checkDetailsAction(
          details({ ...values, testbedTypeId: "" }),
          "1",
        ),
      ).toEqual({
        kind: "error",
        code: "invalid",
        fields: { testbedTypeId: "Choose a lab type." },
      });
      expect(
        await bucket(trx, `details:email:${learner.email.toLowerCase()}`),
      ).toEqual([{ count: 1 }]);
    }));

  it("refuses a second booking of the signed in learner", () =>
    run(async (trx) => {
      const { type, values } = await setup(trx);
      const learner = await makeUser(trx);
      const testbed = await makeTestbed(trx, type.id);
      await trx
        .insertInto("bookings")
        .values({
          user_id: learner.id,
          testbed_id: testbed.id,
          testbed_type_id: type.id,
          starts_at: slot(72),
          ends_at: slot(74),
          status: "confirmed",
        })
        .execute();
      signIn(learner);
      expect(await checkDetailsAction(details(values), "1")).toEqual({
        kind: "error",
        code: "has_live_booking",
        fields: {},
      });
    }));

  it("answers signed_out to an account post with no active learner, and books nothing", () =>
    run(async (trx) => {
      const { values, bookings } = await setup(trx);
      const admin = await makeUser(trx, { role: "admin" });
      const gone = await makeUser(trx, {
        status: "deactivated",
        deactivated_at: new Date(),
      });
      const signedOut = { kind: "error", code: "signed_out", fields: {} };
      for (const who of [undefined, admin, gone]) {
        ctx.session = undefined;
        if (who) signIn(who);
        ctx.ip = uniqueIp();
        expect(
          await bookAction(IDLE, form({ ...values, asAccount: "1" })),
        ).toEqual(signedOut);
        expect(await checkDetailsAction(details(values), "1")).toEqual(
          signedOut,
        );
      }
      expect(ctx.verified).toBe(0);
      expect(await bookings()).toEqual([]);
    }));

  it("books from the form as today for an admin or deactivated session without asAccount", () =>
    run(async (trx) => {
      const { values, email } = await setup(trx);
      const admin = await makeUser(trx, { role: "admin" });
      signIn(admin);
      expect(await checkDetailsAction(details(values))).toEqual({
        kind: "ok",
      });
      expect(await bookAction(IDLE, form(values))).toMatchObject({
        kind: "booked",
        timezone: "America/New_York",
      });
      const guest = await trx
        .selectFrom("users")
        .select("id")
        .where("email", "=", email)
        .executeTakeFirstOrThrow();
      expect(await bookingsOf(trx, guest.id)).toHaveLength(1);
    }));
});

// covers: spec 0012 AC-2, AC-3
describe.skipIf(!hasDb)("bookAction lab access (spec 0012)", () => {
  const PORTAL = "https://lab-portal.example.test";

  // A verified learner and a type whose only testbed has distinct URLs.
  async function learnerWorld(trx: Kysely<DB>) {
    const { type, values } = await setup(trx);
    await trx
      .updateTable("testbeds")
      .set({ portal_url: PORTAL, lms_url: "https://lab-lms.example.test" })
      .where("testbed_type_id", "=", type.id)
      .execute();
    const learner = await makeUser(trx, { email_verified_at: new Date() });
    return { values, learner };
  }

  it("gives the signed in learner who booked their links", () =>
    run(async (trx) => {
      const { values, learner } = await learnerWorld(trx);
      signIn(learner);
      const state = await bookAction(IDLE, form({ ...values, asAccount: "1" }));
      expect(state).toMatchObject({
        kind: "booked",
        access: {
          portalUrl: PORTAL,
          lmsUrl: "https://lab-lms.example.test",
          clients: [],
        },
      });
    }));

  it("never gives a guest links, even with a verified learner's email", () =>
    run(async (trx) => {
      const { values, learner } = await learnerWorld(trx);
      const state = await bookAction(
        IDLE,
        form({ ...values, email: learner.email, name: learner.name }),
      );
      expect(state).toMatchObject({ kind: "booked", access: null });
      const json = JSON.stringify(state);
      expect(json).not.toContain(PORTAL);
      expect(json).not.toContain("lab-lms.example.test");
    }));
});
