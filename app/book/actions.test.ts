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
