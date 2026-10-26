import "server-only";
import { createHmac } from "node:crypto";
import type { Kysely } from "kysely";
import {
  clearCleanupFailed,
  cleanupHookStamp,
  setCleanupFailed,
  type CleanupHookConfig,
  type CleanupHookSource,
  type CleanupStamp,
} from "@/server/catalog/api-keys";
import { audit } from "@/server/audit";
import { dbNow } from "@/server/db/bookings";
import type { DB } from "@/server/db/types";
import {
  cleanupPayload,
  type CleanupEvent,
  type CleanupPayload,
} from "./cleanup-queue";
import {
  claimJob,
  finishJob,
  JOB_BUDGET,
  sweepExhausted,
  TIME_BUDGET_MS,
  type ClaimedJob,
  type JobOutcome,
} from "./runner";

// Spec 0021 AC-5 to AC-7, AC-10, AC-12, AC-13: the worker's "cleanup hook"
// step. It sends the signed POST for each cleanup_notify job and records the
// outcome in the job's own transaction; the audit row and the Needs attention
// marker follow it, on the main connection (the way markGoogleRejected does).
// The URL and secret live in memory for one call: never in a log, a job row,
// an error, or audit metadata (AC-9), so every message here is fixed text.

export const HOOK_TIMEOUT_MS = 5_000;
// Spec 0020's hold after a lab ends: its own constant, because only the slot
// rules may read the gap's constant (tests/gap-invisible-scan.test.ts); a test
// keeps the two equal.
export const STALE_AFTER_MS = 30 * 60 * 1000;

export type FailReason =
  | "timeout"
  | "network"
  | "status_4xx"
  | "status_5xx"
  | "redirect"
  | "config"
  | "stale"
  | "crashed";

// What lands in jobs.last_error, by reason.
const REASON_TEXT = {
  timeout: "The hook did not answer in time.",
  network: "The hook could not be reached.",
  status_4xx: "The hook refused the call.",
  status_5xx: "The hook answered with a server error.",
  redirect: "The hook answered with a redirect, which is not followed.",
  config: "The CLEANUP API key can't be read.",
  stale: "Not sent: the lab ended over 30 minutes ago.",
  crashed: "The worker stopped during the last attempt.",
} as const satisfies Record<FailReason, string>;

const UNEXPECTED = "The job failed unexpectedly.";
// finishJob wants a sign in method for a breaker outcome, which the hook
// never returns.
const NO_BREAKER = "service_account";

export type HookResult = {
  readonly outcome: JobOutcome;
  // Set on every outcome that is a failure if it ends the job.
  readonly reason?: FailReason;
  // A 2xx: the marker may clear.
  readonly delivered?: CleanupStamp;
  // The key as seen, for the failure marker.
  readonly stamp?: CleanupStamp;
};

const done = (extra: Omit<HookResult, "outcome"> = {}): HookResult => ({
  outcome: { kind: "done" },
  ...extra,
});
const retry = (reason: FailReason, stamp?: CleanupStamp): HookResult => ({
  outcome: { kind: "retry", error: REASON_TEXT[reason] },
  reason,
  stamp,
});
const final = (reason: FailReason, stamp?: CleanupStamp): HookResult => ({
  outcome: { kind: "final", error: REASON_TEXT[reason] },
  reason,
  stamp,
});

// AC-5: HMAC SHA256 of "<timestamp>.<raw body>" under the secret.
export const signHook = (
  secret: string,
  timestamp: number,
  body: string,
): string =>
  `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;

// AC-6: a reply's class. 2xx finishes; a timeout-like status retries; a
// redirect and any other reply are final.
export function replyResult(status: number, stamp: CleanupStamp): HookResult {
  if (status >= 200 && status < 300) return done({ delivered: stamp });
  if (status === 408 || status === 429) return retry("status_4xx", stamp);
  if (status >= 500) return retry("status_5xx", stamp);
  if (status >= 300 && status < 400) return final("redirect", stamp);
  return final("status_4xx", stamp);
}

const bodyFor = (
  payload: CleanupPayload,
  jobId: string,
  testbed: {
    readonly id: string;
    readonly name: string;
    readonly domain: string | null;
  },
): string =>
  JSON.stringify({
    event: payload.event,
    deliveryId: jobId,
    occurredAt: payload.occurredAt,
    booking: {
      id: payload.bookingId,
      startsAt: payload.oldStartsAt,
      endsAt: payload.oldEndsAt,
    },
    testbed,
  });

async function send(
  trx: Kysely<DB>,
  job: ClaimedJob,
  payload: CleanupPayload,
  config: CleanupHookConfig,
  fetchFn: typeof fetch,
): Promise<HookResult> {
  const testbed = await trx
    .selectFrom("testbeds")
    .select(["id", "name", "domain"])
    .where("id", "=", payload.oldTestbedId)
    .executeTakeFirstOrThrow();
  const body = bodyFor(payload, job.id, testbed);
  // AC-5: fresh on every retry; the delivery id stays the job's.
  const timestamp = Math.floor((await dbNow(trx)).getTime() / 1000);
  try {
    const res = await fetchFn(config.url, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(HOOK_TIMEOUT_MS),
      headers: {
        "Content-Type": "application/json",
        "X-HOL-Event": payload.event,
        "X-HOL-Delivery": job.id,
        "X-HOL-Timestamp": String(timestamp),
        "X-HOL-Signature": signHook(config.secret, timestamp, body),
      },
      body,
    });
    await res.body?.cancel().catch(() => undefined);
    return replyResult(res.status, config);
  } catch (e) {
    const timedOut = e instanceof Error && e.name === "TimeoutError";
    return retry(timedOut ? "timeout" : "network", config);
  }
}

export type HookDeps = {
  readonly source: () => Promise<CleanupHookSource>;
  readonly fetch?: typeof fetch;
};

// One job, inside its transaction. The key is read at send time (AC-10).
export async function runCleanupNotify(
  trx: Kysely<DB>,
  job: ClaimedJob,
  deps: HookDeps,
): Promise<HookResult> {
  const source = await deps.source();
  // AC-10: the key is gone, so there is nothing to tell.
  if (source.kind === "off") return done();
  const parsed = cleanupPayload.safeParse(job.payload);
  if (!parsed.success) return final("crashed");
  const payload = parsed.data;
  const stamp = source.kind === "on" ? source.config : source.stamp;
  // AC-12: a late retry must never reset a testbed the next learner started on.
  const now = await dbNow(trx);
  if (now.getTime() - new Date(payload.occurredAt).getTime() > STALE_AFTER_MS)
    return final("stale", stamp);
  if (source.kind === "broken") return final("config", stamp);
  return send(trx, job, payload, source.config, deps.fetch ?? fetch);
}

export type HookStep = {
  readonly ran: number;
  readonly failed: readonly string[];
};

const marking = async (what: string, write: () => Promise<void>) => {
  try {
    await write();
  } catch {
    console.error(
      `cleanup hook: couldn't ${what} the CLEANUP key's Needs attention marker`,
    );
  }
};

// AC-7: the audit row and the marker, written after the job's transaction.
async function recordFailure(
  conn: Kysely<DB>,
  payload: CleanupPayload | null,
  reason: FailReason,
  stamp: CleanupStamp | null,
): Promise<void> {
  if (payload)
    await audit(conn, {
      actorUserId: null,
      action: "cleanup_hook.failed",
      targetType: "booking",
      targetId: payload.bookingId,
      summary: "Cleanup hook failed",
      metadata: { event: payload.event satisfies CleanupEvent, reason },
    });
  if (stamp) await marking("set", () => setCleanupFailed(conn, stamp));
}

async function runOne(
  conn: Kysely<DB>,
  job: ClaimedJob,
  deps: HookDeps,
): Promise<"done" | "pending" | "failed"> {
  const payload = cleanupPayload.safeParse(job.payload);
  const known = payload.success ? payload.data : null;
  try {
    const { status, result } = await conn.transaction().execute(async (trx) => {
      const result = await runCleanupNotify(trx, job, deps);
      return {
        status: await finishJob(trx, job, result.outcome, NO_BREAKER),
        result,
      };
    });
    if (status === "failed")
      await recordFailure(
        conn,
        known,
        result.reason ?? "crashed",
        result.stamp ?? null,
      );
    if (result.delivered) {
      const stamp = result.delivered;
      await marking("clear", () => clearCleanupFailed(conn, stamp));
    }
    return status;
  } catch (e) {
    // A bug or a database error: the work rolled back and the attempt counts.
    // The message is logged, never stored (it could echo data).
    console.error(
      `cleanup hook: ${job.id} threw: ${e instanceof Error ? e.message : String(e)}`,
    );
    const status = await conn
      .transaction()
      .execute((trx) =>
        finishJob(trx, job, { kind: "retry", error: UNEXPECTED }, NO_BREAKER),
      );
    if (status === "failed")
      await recordFailure(conn, known, "crashed", await cleanupHookStamp(conn));
    return status;
  }
}

// AC-13: claims only cleanup_notify jobs and needs no Google key. The
// exhausted-lease sweep runs first; a job it fails is surfaced the same way
// (reason crashed).
export async function runCleanupHooks(
  conn: Kysely<DB>,
  deps: HookDeps & { readonly clock?: () => number },
): Promise<HookStep> {
  const swept = await sweepExhausted(conn, ["cleanup_notify"]);
  const stamp = swept.length > 0 ? await cleanupHookStamp(conn) : null;
  for (const job of swept) {
    const payload = cleanupPayload.safeParse(job.payload);
    await recordFailure(
      conn,
      payload.success ? payload.data : null,
      "crashed",
      stamp,
    );
  }
  const clock = deps.clock ?? Date.now;
  const started = clock();
  const failed: string[] = swept.map((j) => `cleanup_notify ${j.id}`);
  let ran = 0;
  while (ran < JOB_BUDGET && clock() - started < TIME_BUDGET_MS) {
    const job = await claimJob(conn, ["cleanup_notify"]);
    if (!job) break;
    ran += 1;
    if ((await runOne(conn, job, deps)) === "failed")
      failed.push(`cleanup_notify ${job.id}`);
  }
  return { ran, failed };
}
