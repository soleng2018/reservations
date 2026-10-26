import { createHmac, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { sql, type Kysely, type Transaction } from "kysely";
import { afterAll, describe, expect, it } from "vitest";
import { GAP_MS } from "@/lib/slots";
import {
  cleanupHookConfig,
  cleanupHookOn,
  createApiKey,
  updateApiKey,
  type CleanupHookSource,
} from "@/server/catalog/api-keys";
import type { Keyring } from "@/server/crypto/secrets";
import { db } from "@/server/db";
import { cancelBooking, rescheduleBooking } from "@/server/db/bookings";
import {
  asConn,
  hasDb,
  inRollback,
  makeTestbed,
  makeType,
  makeUser,
  slot,
} from "@/server/db/testing";
import type { DB } from "@/server/db/types";
import {
  HOOK_TIMEOUT_MS,
  replyResult,
  runCleanupHooks,
  runCleanupNotify,
  signHook,
  STALE_AFTER_MS,
} from "./cleanup-hook";
import { cleanupPayload, queueCleanupNotice } from "./cleanup-queue";
import { claimJob, runJobs } from "./runner";

// Spec 0021: the cleanup hook for labs that end early. DB tests run inside
// inRollback with an in memory keyring; the shared queue is parked first.

const KEYRING: Keyring = {
  activeKeyId: "ktest",
  keys: new Map([["ktest", randomBytes(32)]]),
};
const SECRET = "hook-signing-secret-canary";
const URL_CANARY = "https://hooks.example.test/webhook/path-canary-1234";
const stamp = {
  id: crypto.randomUUID(),
  url: URL_CANARY,
  secretUpdatedAt: new Date(),
};

afterAll(() => (hasDb ? db().destroy() : undefined));

describe("signHook and replyResult (spec 0021 AC-5, AC-6)", () => {
  // covers: AC-5, HMAC SHA256 over "<timestamp>.<body>", hex, sha256= prefix
  it("signs timestamp dot body with the secret", () => {
    const expected = createHmac("sha256", "s3cret-s3cret-s3cret")
      .update('1700000000.{"a":1}')
      .digest("hex");
    expect(signHook("s3cret-s3cret-s3cret", 1_700_000_000, '{"a":1}')).toBe(
      `sha256=${expected}`,
    );
  });

  // covers: AC-6, each reply class
  it.each([
    [200, "done", undefined],
    [204, "done", undefined],
    [408, "retry", "status_4xx"],
    [429, "retry", "status_4xx"],
    [500, "retry", "status_5xx"],
    [503, "retry", "status_5xx"],
    [404, "final", "status_4xx"],
    [400, "final", "status_4xx"],
    [301, "final", "redirect"],
    [302, "final", "redirect"],
  ] as const)("reads a %i reply as %s", (status, kind, reason) => {
    const r = replyResult(status, stamp);
    expect(r.outcome.kind).toBe(kind);
    expect(r.reason).toBe(reason);
  });

  // covers: AC-6, the call is short against the job lease
  it("times out well inside the 5 minute lease", () => {
    expect(HOOK_TIMEOUT_MS).toBe(5000);
  });

  // covers: AC-12, the stale cutoff is spec 0020's hold
  it("keeps the stale cutoff equal to the cleanup gap", () => {
    expect(STALE_AFTER_MS).toBe(GAP_MS);
  });
});

const parkRealJobs = (trx: Kysely<DB>) =>
  trx
    .updateTable("jobs")
    .set({ status: "failed" })
    .where("status", "in", ["pending", "running"])
    .execute();

// A learner, a testbed, and a live CLEANUP key (any real one set aside).
async function world(trx: Transaction<DB>, withKey = true) {
  await parkRealJobs(trx);
  await trx
    .updateTable("api_keys")
    .set({ deleted_at: new Date() })
    .where("type", "=", "CLEANUP")
    .where("deleted_at", "is", null)
    .execute();
  const admin = await makeUser(trx, { role: "admin" });
  const learner = await makeUser(trx);
  const type = await makeType(trx);
  const testbed = await makeTestbed(trx, type.id);
  const key = withKey
    ? await createApiKey(
        asConn(trx),
        KEYRING,
        {
          name: `Cleanup ${crypto.randomUUID().slice(0, 6)}`,
          type: "CLEANUP",
          baseUrl: URL_CANARY,
          secret: SECRET,
        },
        admin.id,
      )
    : undefined;
  if (key && !key.ok) throw new Error("expected a CLEANUP key");
  const book = async (startsHoursFromNow: number, hours = 2) => {
    const startsAt = slot(startsHoursFromNow);
    return trx
      .insertInto("bookings")
      .values({
        user_id: learner.id,
        testbed_id: testbed.id,
        testbed_type_id: type.id,
        starts_at: startsAt,
        ends_at: new Date(startsAt.getTime() + hours * 3_600_000),
        status: "confirmed",
      })
      .returning(["id", "starts_at", "ends_at"])
      .executeTakeFirstOrThrow();
  };
  return { admin, learner, type, testbed, keyId: key?.value.id, book, trx };
}

const cancel = (trx: Kysely<DB>, id: string, version = 1) =>
  cancelBooking(trx, {
    id,
    expectedVersion: version,
    source: "admin",
    byUserId: null,
  });

const hookJobs = (trx: Kysely<DB>) =>
  trx
    .selectFrom("jobs")
    .selectAll()
    .where("kind", "=", "cleanup_notify")
    .where("status", "=", "pending")
    .orderBy("idempotency_key")
    .execute();

describe.skipIf(!hasDb)("queueing (spec 0021 AC-2, AC-3, AC-4, AC-8)", () => {
  // covers: AC-2, a Current cancel queues one booking.ended_early job
  it("queues one job when a Current booking is cancelled", () =>
    inRollback(async (trx) => {
      const w = await world(trx);
      const b = await w.book(-1);
      expect(await cancel(trx, b.id)).toEqual({
        ok: true,
        value: { version: 2 },
      });
      const jobs = await hookJobs(trx);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.idempotency_key).toBe(`cleanup:${b.id}:2`);
      const payload = cleanupPayload.parse(jobs[0]?.payload);
      expect(payload).toMatchObject({
        bookingId: b.id,
        event: "booking.ended_early",
        oldTestbedId: w.testbed.id,
        oldStartsAt: b.starts_at.toISOString(),
        oldEndsAt: b.ends_at.toISOString(),
      });
      // AC-9: ids and times only.
      expect(JSON.stringify(jobs[0]?.payload)).not.toMatch(
        /canary|hooks\.example|https?:/,
      );
    }));

  // covers: AC-2, every cancel source queues
  it.each(["learner", "admin", "deactivation"] as const)(
    "queues for a %s cancel",
    (source) =>
      inRollback(async (trx) => {
        const w = await world(trx);
        const b = await w.book(-1);
        await cancelBooking(trx, {
          id: b.id,
          expectedVersion: 1,
          source,
          byUserId: source === "deactivation" ? null : w.admin.id,
        });
        expect(await hookJobs(trx)).toHaveLength(1);
      }),
  );

  // covers: AC-2, an Upcoming cancel queues nothing
  it("queues nothing for an Upcoming booking", () =>
    inRollback(async (trx) => {
      const w = await world(trx);
      const b = await w.book(3);
      await cancel(trx, b.id);
      expect(await hookJobs(trx)).toEqual([]);
    }));

  // covers: AC-4, no live key, nothing queued and the cancel is the same
  it("queues nothing without a live CLEANUP key", () =>
    inRollback(async (trx) => {
      const w = await world(trx, false);
      const b = await w.book(-1);
      expect(await cancel(trx, b.id)).toEqual({
        ok: true,
        value: { version: 2 },
      });
      expect(await hookJobs(trx)).toEqual([]);
      expect(await cleanupHookOn(trx)).toBe(false);
    }));

  // covers: AC-2, a stale cancel changes nothing and queues nothing
  it("queues nothing when the cancel is stale", () =>
    inRollback(async (trx) => {
      const w = await world(trx);
      const b = await w.book(-1);
      expect(await cancel(trx, b.id, 7)).toEqual({ ok: false, error: "stale" });
      expect(await hookJobs(trx)).toEqual([]);
    }));

  // covers: AC-3, a Current reschedule names the old testbed and times
  it("queues booking.moved for a Current reschedule", () =>
    inRollback(async (trx) => {
      const w = await world(trx);
      const other = await makeTestbed(trx, w.type.id);
      const b = await w.book(-1);
      const moved = await rescheduleBooking(trx, {
        id: b.id,
        expectedVersion: 1,
        testbedId: other.id,
        testbedTypeId: w.type.id,
        startsAt: slot(30),
        endsAt: slot(32),
      });
      expect(moved).toEqual({ ok: true, value: { version: 2 } });
      const [job] = await hookJobs(trx);
      expect(cleanupPayload.parse(job?.payload)).toMatchObject({
        bookingId: b.id,
        event: "booking.moved",
        oldTestbedId: w.testbed.id,
        oldStartsAt: b.starts_at.toISOString(),
        oldEndsAt: b.ends_at.toISOString(),
      });
    }));

  // covers: AC-3, an Upcoming reschedule queues nothing
  it("queues nothing for an Upcoming reschedule", () =>
    inRollback(async (trx) => {
      const w = await world(trx);
      const b = await w.book(25);
      await rescheduleBooking(trx, {
        id: b.id,
        expectedVersion: 1,
        testbedId: w.testbed.id,
        testbedTypeId: w.type.id,
        startsAt: slot(30),
        endsAt: slot(32),
      });
      expect(await hookJobs(trx)).toEqual([]);
    }));

  // covers: AC-8, a repeat queue adds nothing
  it("queues once per booking change", () =>
    inRollback(async (trx) => {
      const w = await world(trx);
      const b = await w.book(-1);
      const notice = {
        bookingId: b.id,
        version: 2,
        event: "booking.ended_early" as const,
        oldTestbedId: w.testbed.id,
        oldStartsAt: b.starts_at,
        oldEndsAt: b.ends_at,
      };
      await queueCleanupNotice(trx, notice);
      await queueCleanupNotice(trx, notice);
      expect(await hookJobs(trx)).toHaveLength(1);
    }));
});

type Call = { readonly url: string; readonly init: RequestInit };
const fakeFetch = (reply: () => Response | Error) => {
  const calls: Call[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const r = reply();
    if (r instanceof Error) throw r;
    return r;
  }) as typeof fetch;
  return { fetchFn, calls };
};

const on = (url = URL_CANARY): CleanupHookSource => ({
  kind: "on",
  config: {
    id: stamp.id,
    url,
    secret: SECRET,
    secretUpdatedAt: stamp.secretUpdatedAt,
  },
});

// Queues a Current cancel's job, claims it, and runs the handler on it.
async function claimed(w: Awaited<ReturnType<typeof world>>) {
  const b = await w.book(-1);
  await cancel(w.trx, b.id);
  const job = await claimJob(w.trx, ["cleanup_notify"]);
  if (!job) throw new Error("expected a job");
  return { b, job };
}

describe.skipIf(!hasDb)(
  "runCleanupNotify (spec 0021 AC-5, AC-6, AC-10, AC-12)",
  () => {
    // covers: AC-5, the headers, the signature, and the body
    it("sends a signed POST with the documented headers and body", () =>
      inRollback(async (trx) => {
        const w = await world(trx);
        const { b, job } = await claimed(w);
        const { fetchFn, calls } = fakeFetch(() => new Response("ok"));
        const r = await runCleanupNotify(trx, job, {
          source: async () => on(),
          fetch: fetchFn,
        });
        expect(r.outcome).toEqual({ kind: "done" });
        expect(calls).toHaveLength(1);
        const [{ url, init }] = calls as [Call];
        expect(url).toBe(URL_CANARY);
        expect(init.method).toBe("POST");
        expect(init.redirect).toBe("manual");
        expect(init.signal).toBeInstanceOf(AbortSignal);
        const headers = init.headers as Record<string, string>;
        expect(headers["X-HOL-Event"]).toBe("booking.ended_early");
        expect(headers["X-HOL-Delivery"]).toBe(job.id);
        expect(headers["Content-Type"]).toBe("application/json");
        const ts = Number(headers["X-HOL-Timestamp"]);
        expect(Math.abs(ts - Date.now() / 1000)).toBeLessThan(120);
        const body = String(init.body);
        expect(headers["X-HOL-Signature"]).toBe(signHook(SECRET, ts, body));
        expect(JSON.parse(body)).toEqual({
          event: "booking.ended_early",
          deliveryId: job.id,
          occurredAt: expect.any(String),
          booking: {
            id: b.id,
            startsAt: b.starts_at.toISOString(),
            endsAt: b.ends_at.toISOString(),
          },
          testbed: {
            id: w.testbed.id,
            name: w.testbed.name,
            domain: w.testbed.domain,
          },
        });
        // No learner data in the body.
        expect(body).not.toContain(w.learner.email);
        expect(body).not.toContain(w.learner.name);
        expect(body).not.toContain(w.testbed.group_name);
      }));

    // covers: AC-6, retry classes and final classes with fixed messages
    it.each([
      [() => new Response("", { status: 429 }), "retry", "status_4xx"],
      [() => new Response("", { status: 500 }), "retry", "status_5xx"],
      [() => new Response("", { status: 404 }), "final", "status_4xx"],
      [() => new Response("", { status: 302 }), "final", "redirect"],
      [
        () => Object.assign(new Error("t"), { name: "TimeoutError" }),
        "retry",
        "timeout",
      ],
      [() => new TypeError(`fetch failed ${URL_CANARY}`), "retry", "network"],
    ] as const)("handles reply %#", (reply, kind, reason) =>
      inRollback(async (trx) => {
        const w = await world(trx);
        const { job } = await claimed(w);
        const { fetchFn } = fakeFetch(reply);
        const r = await runCleanupNotify(trx, job, {
          source: async () => on(),
          fetch: fetchFn,
        });
        expect(r.outcome.kind).toBe(kind);
        expect(r.reason).toBe(reason);
        // AC-9: the stored message is fixed text.
        const error = "error" in r.outcome ? r.outcome.error : "";
        expect(error).not.toMatch(/canary|hooks\.example|https?:/);
      }),
    );

    // covers: AC-10, the key deleted after queueing: done, no call
    it("finishes done with no call when the key is gone", () =>
      inRollback(async (trx) => {
        const w = await world(trx);
        const { job } = await claimed(w);
        const { fetchFn, calls } = fakeFetch(() => new Response("ok"));
        const r = await runCleanupNotify(trx, job, {
          source: async () => ({ kind: "off" }),
          fetch: fetchFn,
        });
        expect(r).toEqual({ outcome: { kind: "done" } });
        expect(calls).toEqual([]);
      }));

    // covers: AC-10, a replaced URL is the one used
    it("sends to the config read now", () =>
      inRollback(async (trx) => {
        const w = await world(trx);
        const { job } = await claimed(w);
        const { fetchFn, calls } = fakeFetch(() => new Response("ok"));
        await runCleanupNotify(trx, job, {
          source: async () => on("https://new.example.test/hook"),
          fetch: fetchFn,
        });
        expect(calls[0]?.url).toBe("https://new.example.test/hook");
      }));

    // covers: AC-6, a decrypt failure is final with reason config
    it("fails a broken key as config", () =>
      inRollback(async (trx) => {
        const w = await world(trx);
        const { job } = await claimed(w);
        const { fetchFn, calls } = fakeFetch(() => new Response("ok"));
        const r = await runCleanupNotify(trx, job, {
          source: async () => ({ kind: "broken", stamp }),
          fetch: fetchFn,
        });
        expect(r.outcome.kind).toBe("final");
        expect(r.reason).toBe("config");
        expect(calls).toEqual([]);
      }));

    // covers: AC-12, an old event is never sent
    it("refuses a job older than 30 minutes without a call", () =>
      inRollback(async (trx) => {
        const w = await world(trx);
        const { job } = await claimed(w);
        await trx
          .updateTable("jobs")
          .set({
            payload: sql`jsonb_set(payload, '{occurredAt}', to_jsonb(to_char((now() - interval '31 minutes') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))`,
          })
          .where("id", "=", job.id)
          .execute();
        const fresh = await trx
          .selectFrom("jobs")
          .select("payload")
          .where("id", "=", job.id)
          .executeTakeFirstOrThrow();
        const { fetchFn, calls } = fakeFetch(() => new Response("ok"));
        const r = await runCleanupNotify(
          trx,
          { ...job, payload: fresh.payload },
          { source: async () => on(), fetch: fetchFn },
        );
        expect(r.reason).toBe("stale");
        expect(r.outcome.kind).toBe("final");
        expect(calls).toEqual([]);
      }));
  },
);

describe("a real receiver (spec 0021 AC-5, AC-6)", () => {
  // covers: AC-5, AC-6, a redirect is read as a reply, not followed
  it("does not follow a redirect", async () => {
    const seen: string[] = [];
    const server = createServer((req, res) => {
      seen.push(req.url ?? "");
      if (req.url === "/hook") {
        res.writeHead(302, { Location: "/elsewhere" }).end();
      } else res.writeHead(200).end("ok");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/hook`, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(HOOK_TIMEOUT_MS),
        body: "{}",
      });
      expect(res.status).toBe(302);
      expect(replyResult(res.status, stamp).reason).toBe("redirect");
      expect(seen).toEqual(["/hook"]);
    } finally {
      server.close();
    }
  });
});

const failedAudits = (trx: Kysely<DB>, bookingId: string) =>
  trx
    .selectFrom("audit_events")
    .select(["action", "actor_user_id", "target_type", "metadata"])
    .where("action", "=", "cleanup_hook.failed")
    .where("target_id", "=", bookingId)
    .execute();

const failedAt = async (trx: Kysely<DB>, keyId: string) =>
  (
    await trx
      .selectFrom("api_keys")
      .select("cleanup_failed_at")
      .where("id", "=", keyId)
      .executeTakeFirstOrThrow()
  ).cleanup_failed_at;

const liveSource = (trx: Kysely<DB>) => () =>
  cleanupHookConfig(trx, () => KEYRING);

describe.skipIf(!hasDb)("runCleanupHooks (spec 0021 AC-6, AC-7, AC-13)", () => {
  // covers: AC-6, a 2xx finishes the job
  it("finishes a delivered job", () =>
    inRollback(async (trx) => {
      const w = await world(trx);
      const { b, job } = await claimed(w);
      await trx
        .updateTable("jobs")
        .set({ status: "pending", locked_until: null, attempts: 0 })
        .where("id", "=", job.id)
        .execute();
      const { fetchFn, calls } = fakeFetch(() => new Response("ok"));
      const step = await runCleanupHooks(asConn(trx), {
        source: liveSource(trx),
        fetch: fetchFn,
      });
      expect(step).toEqual({ ran: 1, failed: [] });
      expect(calls).toHaveLength(1);
      const row = await trx
        .selectFrom("jobs")
        .select(["status", "last_error"])
        .where("id", "=", job.id)
        .executeTakeFirstOrThrow();
      expect(row).toEqual({ status: "done", last_error: null });
      expect(await failedAudits(trx, b.id)).toEqual([]);
    }));

  // covers: AC-7, a final reply fails the job, audits it, and marks the key;
  // the booking is untouched
  it("audits and marks a final failure, then a 2xx clears the mark", () =>
    inRollback(async (trx) => {
      const w = await world(trx);
      const first = await claimed(w);
      await trx
        .updateTable("jobs")
        .set({ status: "pending", locked_until: null, attempts: 0 })
        .where("id", "=", first.job.id)
        .execute();
      const bad = fakeFetch(() => new Response("", { status: 404 }));
      const step = await runCleanupHooks(asConn(trx), {
        source: liveSource(trx),
        fetch: bad.fetchFn,
      });
      expect(step.failed).toEqual([`cleanup_notify ${first.job.id}`]);
      expect(await failedAudits(trx, first.b.id)).toEqual([
        {
          action: "cleanup_hook.failed",
          actor_user_id: null,
          target_type: "booking",
          metadata: { event: "booking.ended_early", reason: "status_4xx" },
        },
      ]);
      expect(await failedAt(trx, w.keyId ?? "")).toBeInstanceOf(Date);
      const booking = await trx
        .selectFrom("bookings")
        .select("status")
        .where("id", "=", first.b.id)
        .executeTakeFirstOrThrow();
      expect(booking.status).toBe("cancelled");

      const second = await w.book(-1, 3);
      await cancel(trx, second.id);
      const good = fakeFetch(() => new Response("ok"));
      await runCleanupHooks(asConn(trx), {
        source: liveSource(trx),
        fetch: good.fetchFn,
      });
      expect(await failedAt(trx, w.keyId ?? "")).toBeNull();
    }));

  // covers: AC-6, a retry is rescheduled; attempts used up fails it
  it("retries a 500 and fails the job on its last attempt", () =>
    inRollback(async (trx) => {
      const w = await world(trx);
      const { b, job } = await claimed(w);
      const err500 = fakeFetch(() => new Response("", { status: 500 }));
      await trx
        .updateTable("jobs")
        .set({ status: "pending", locked_until: null, attempts: 0 })
        .where("id", "=", job.id)
        .execute();
      await runCleanupHooks(asConn(trx), {
        source: liveSource(trx),
        fetch: err500.fetchFn,
      });
      const after = await trx
        .selectFrom("jobs")
        .select(["status", "attempts", "last_error"])
        .where("id", "=", job.id)
        .executeTakeFirstOrThrow();
      expect(after).toMatchObject({ status: "pending", attempts: 1 });
      expect(await failedAudits(trx, b.id)).toEqual([]);

      await trx
        .updateTable("jobs")
        .set({ attempts: 7, run_at: sql`now()` })
        .where("id", "=", job.id)
        .execute();
      await runCleanupHooks(asConn(trx), {
        source: liveSource(trx),
        fetch: err500.fetchFn,
      });
      const last = await trx
        .selectFrom("jobs")
        .select(["status", "attempts"])
        .where("id", "=", job.id)
        .executeTakeFirstOrThrow();
      expect(last).toEqual({ status: "failed", attempts: 8 });
      expect(await failedAudits(trx, b.id)).toHaveLength(1);
    }));

  // covers: AC-7, a job the sweeper fails (crashed) is surfaced too
  it("audits and marks a swept job as crashed", () =>
    inRollback(async (trx) => {
      const w = await world(trx);
      const { b, job } = await claimed(w);
      await trx
        .updateTable("jobs")
        .set({
          status: "running",
          attempts: 8,
          locked_until: sql`now() - interval '1 minute'`,
        })
        .where("id", "=", job.id)
        .execute();
      const { fetchFn, calls } = fakeFetch(() => new Response("ok"));
      const step = await runCleanupHooks(asConn(trx), {
        source: liveSource(trx),
        fetch: fetchFn,
      });
      expect(step.failed).toEqual([`cleanup_notify ${job.id}`]);
      expect(calls).toEqual([]);
      expect(await failedAudits(trx, b.id)).toMatchObject([
        { metadata: { event: "booking.ended_early", reason: "crashed" } },
      ]);
      expect(await failedAt(trx, w.keyId ?? "")).toBeInstanceOf(Date);
    }));

  // covers: AC-7, a key saved since never takes the old config's failure
  it("does not mark a key saved since the worker read it", () =>
    inRollback(async (trx) => {
      const w = await world(trx);
      const { job } = await claimed(w);
      await trx
        .updateTable("jobs")
        .set({ status: "pending", locked_until: null, attempts: 0 })
        .where("id", "=", job.id)
        .execute();
      const { fetchFn } = fakeFetch(() => {
        // The admin saves a new secret while the call is in flight.
        throw new TypeError("never reached");
      });
      let read: CleanupHookSource | undefined;
      await runCleanupHooks(asConn(trx), {
        source: async () => {
          read = await cleanupHookConfig(trx, () => KEYRING);
          await updateApiKey(
            asConn(trx),
            KEYRING,
            w.keyId ?? "",
            {
              name: "renamed",
              type: "CLEANUP",
              baseUrl: URL_CANARY,
              secret: "another-signing-secret",
            },
            w.admin.id,
          );
          await trx
            .updateTable("api_keys")
            .set({ secret_updated_at: new Date(Date.now() + 5000) })
            .where("id", "=", w.keyId ?? "")
            .execute();
          return read;
        },
        fetch: fetchFn,
      });
      expect(read?.kind).toBe("on");
      expect(await failedAt(trx, w.keyId ?? "")).toBeNull();
    }));

  // covers: AC-13, the hook runs with no Google key, and the jobs step never
  // claims it
  it("runs without a Google key, and runJobs leaves the job alone", () =>
    inRollback(async (trx) => {
      const w = await world(trx);
      const { job } = await claimed(w);
      await trx
        .updateTable("jobs")
        .set({ status: "pending", locked_until: null, attempts: 0 })
        .where("id", "=", job.id)
        .execute();
      const noKey = await runJobs(asConn(trx), {
        handlers: {},
        config: async () => null,
      });
      expect(noKey).toEqual({ kind: "no_key" });
      const withKey = await runJobs(asConn(trx), {
        handlers: {
          cleanup_notify: async () => {
            throw new Error("the jobs step must not claim the hook");
          },
        },
        config: async () => ({
          id: crypto.randomUUID(),
          credentials: {
            method: "service_account",
            clientEmail: "a@b.test",
            privateKey: "k",
            privateKeyId: "i",
          },
          secretUpdatedAt: new Date(),
          senderEmail: "labs@nile.example",
          calendarId: "c",
          devInbox: null,
          opsBcc: null,
          stamp: crypto.randomUUID(),
        }),
      });
      expect(withKey).toMatchObject({ kind: "ran", ran: 0 });
      const { fetchFn } = fakeFetch(() => new Response("ok"));
      const step = await runCleanupHooks(asConn(trx), {
        source: liveSource(trx),
        fetch: fetchFn,
      });
      expect(step.ran).toBe(1);
    }));

  // covers: AC-1, AC-7, one live key; saves clear the mark only on a change
  it("refuses a second CLEANUP key and clears the mark on a changing save", () =>
    inRollback(async (trx) => {
      const w = await world(trx);
      const second = await createApiKey(
        asConn(trx),
        KEYRING,
        {
          name: "Second hook",
          type: "CLEANUP",
          baseUrl: "https://other.example.test/hook",
          secret: "sixteen-chars-ok!",
        },
        w.admin.id,
      );
      expect(second).toEqual({ ok: false, error: "cleanup_exists" });

      const same = {
        name: (
          await trx
            .selectFrom("api_keys")
            .select("name")
            .where("id", "=", w.keyId ?? "")
            .executeTakeFirstOrThrow()
        ).name,
        type: "CLEANUP" as const,
        baseUrl: URL_CANARY,
        secret: "",
      };
      await trx
        .updateTable("api_keys")
        .set({ cleanup_failed_at: new Date() })
        .where("id", "=", w.keyId ?? "")
        .execute();
      // Nothing changed: the mark stays.
      await updateApiKey(asConn(trx), KEYRING, w.keyId ?? "", same, w.admin.id);
      expect(await failedAt(trx, w.keyId ?? "")).toBeInstanceOf(Date);
      // A new URL clears it, and the audit diff never names the URL.
      const changed = await updateApiKey(
        asConn(trx),
        KEYRING,
        w.keyId ?? "",
        { ...same, baseUrl: "https://new.example.test/hook2" },
        w.admin.id,
      );
      expect(changed).toEqual({ ok: true, value: undefined });
      expect(await failedAt(trx, w.keyId ?? "")).toBeNull();
      const audits = await trx
        .selectFrom("audit_events")
        .select(["action", "metadata"])
        .where("target_id", "=", w.keyId ?? "")
        .execute();
      expect(JSON.stringify(audits)).not.toMatch(
        /path-canary|new\.example|hooks\.example|canary-secret/,
      );
      expect(audits.some((a) => a.action === "api_key.updated")).toBe(true);
    }));
});
