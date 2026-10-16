import "server-only";
import { sql, type Kysely, type Transaction } from "kysely";
import { z } from "zod";
import { JobKind } from "@/lib/db-enums";
import { err, type Result } from "@/lib/result";
import type { GoogleMailConfig } from "@/server/catalog/api-keys";
import type { DB } from "@/server/db/types";
import type { GoogleCallError, GoogleFetch } from "@/server/google/http";
import {
  googleAccessToken,
  mintAccessToken,
  type MintToken,
  type TokenSource,
} from "@/server/google/token";

// Spec 0013 AC-8 to AC-10: the worker's "jobs" step. It claims due jobs one
// at a time, runs each in its own transaction, and records the outcome in
// that same transaction, so a crash leaves at most a lease to expire.

export const MAX_ATTEMPTS = 8; // jobs_attempts_check caps attempts at 8
const LEASE = sql<Date>`now() + interval '5 minutes'`;
const BREAKER_WAIT = sql<Date>`now() + interval '5 minutes'`;
// 1 minute doubling per attempt, at most an hour.
const BACKOFF = sql<Date>`now() + least(interval '1 minute' * power(2, attempts - 1), interval '1 hour')`;
export const JOB_BUDGET = 20;
export const TIME_BUDGET_MS = 40_000;

export const BREAKER_MESSAGE =
  "Google rejected the service account key. Check the key and domain wide delegation, and upload a new key on API Keys if needed.";
const LEASE_EXHAUSTED = "The worker stopped during the last attempt.";
const UNEXPECTED = "The job failed unexpectedly.";

export type ClaimedJob = {
  readonly id: string;
  readonly kind: JobKind;
  readonly payload: unknown;
  // Already counting this attempt.
  readonly attempts: number;
};

export type JobOutcome =
  | { readonly kind: "done" }
  | { readonly kind: "retry"; readonly error: string }
  | { readonly kind: "final"; readonly error: string }
  // AC-9: Google rejected the credential. The attempt is given back.
  | { readonly kind: "breaker" };

// A Google call made through the context: a 401 drops the cached token,
// mints a fresh one, and repeats the call once (AC-9).
export type GoogleFailure =
  "breaker" | "retry" | { readonly kind: "final"; readonly status: number };

export type JobContext = {
  readonly cfg: GoogleMailConfig;
  readonly fetch: GoogleFetch;
  readonly google: <T>(
    call: (token: string) => Promise<Result<T, GoogleCallError>>,
  ) => Promise<Result<T, GoogleFailure>>;
};

export type JobHandler = (
  trx: Kysely<DB>,
  job: ClaimedJob,
  ctx: JobContext,
) => Promise<JobOutcome>;

export type Handlers = Partial<Record<JobKind, JobHandler>>;

const JobRow = z.object({
  id: z.string(),
  kind: z.string(),
  payload: z.unknown(),
  attempts: z.number(),
});

// AC-8, AC-10. One statement: the oldest due job of a handled kind with
// attempts left, pending and due or running with an expired lease. A
// send_email job waits while an older email of its booking is still queued,
// so a booking's emails go out in version order.
export async function claimJob(
  conn: Kysely<DB>,
  kinds: readonly JobKind[],
): Promise<ClaimedJob | undefined> {
  if (kinds.length === 0) return undefined;
  const { rows } = await sql<z.infer<typeof JobRow>>`
    update hol_app.jobs
    set status = 'running', locked_until = ${LEASE}, attempts = attempts + 1
    where id = (
      select j.id from hol_app.jobs j
      where j.kind in (${sql.join(kinds)})
        and j.attempts < ${MAX_ATTEMPTS}
        and ((j.status = 'pending' and j.run_at <= now())
          or (j.status = 'running' and j.locked_until < now()))
        and not exists (
          select 1
          from hol_app.email_messages m
          join hol_app.email_messages older
            on older.booking_id = m.booking_id
           and older.booking_version < m.booking_version
           and older.status = 'queued'
          where m.job_id = j.id
        )
      order by j.run_at, j.created_at
      limit 1
      for update skip locked
    )
    returning id, kind, payload, attempts`.execute(conn);
  const [row] = rows;
  if (!row) return undefined;
  const parsed = JobRow.parse(row);
  return { ...parsed, kind: JobKind.parse(parsed.kind) };
}

// AC-8: a send_email job that ends failed takes its email row with it, so a
// dead email never blocks the later ones (AC-10).
async function failEmails(
  trx: Kysely<DB>,
  jobIds: readonly string[],
  reason: string,
): Promise<void> {
  if (jobIds.length === 0) return;
  await trx
    .updateTable("email_messages")
    .set({ status: "failed", last_error: reason })
    .where("job_id", "in", jobIds)
    .where("status", "=", "queued")
    .execute();
}

// A queued email's latest problem, shown on the console (AC-21).
async function noteEmail(
  trx: Kysely<DB>,
  jobId: string,
  reason: string,
): Promise<void> {
  await trx
    .updateTable("email_messages")
    .set({ last_error: reason })
    .where("job_id", "=", jobId)
    .where("status", "=", "queued")
    .execute();
}

// Records an outcome inside the job's transaction. Answers the job's new
// status, so the caller can log a failure.
export async function finishJob(
  trx: Kysely<DB>,
  job: ClaimedJob,
  outcome: JobOutcome,
): Promise<"done" | "pending" | "failed"> {
  const fail = async (reason: string) => {
    await trx
      .updateTable("jobs")
      .set({ status: "failed", locked_until: null, last_error: reason })
      .where("id", "=", job.id)
      .execute();
    await failEmails(trx, [job.id], reason);
    return "failed" as const;
  };
  switch (outcome.kind) {
    case "done":
      await trx
        .updateTable("jobs")
        .set({ status: "done", locked_until: null, last_error: null })
        .where("id", "=", job.id)
        .execute();
      return "done";
    case "retry":
      if (job.attempts >= MAX_ATTEMPTS) return fail(outcome.error);
      await trx
        .updateTable("jobs")
        .set({
          status: "pending",
          locked_until: null,
          run_at: BACKOFF,
          last_error: outcome.error,
        })
        .where("id", "=", job.id)
        .execute();
      await noteEmail(trx, job.id, outcome.error);
      return "pending";
    case "final":
      return fail(outcome.error);
    case "breaker":
      await trx
        .updateTable("jobs")
        .set({
          status: "pending",
          locked_until: null,
          attempts: sql<number>`attempts - 1`,
          run_at: BREAKER_WAIT,
          last_error: BREAKER_MESSAGE,
        })
        .where("id", "=", job.id)
        .execute();
      await noteEmail(trx, job.id, BREAKER_MESSAGE);
      return "pending";
    default: {
      const never: never = outcome;
      return never;
    }
  }
}

// AC-8: a job that crashed on its last attempt can never be claimed again
// (attempts would pass the cap), so its expired lease ends it here.
export async function sweepExhausted(
  conn: Kysely<DB>,
  kinds: readonly JobKind[],
): Promise<number> {
  if (kinds.length === 0) return 0;
  return conn.transaction().execute(async (trx) => {
    const failed = await trx
      .updateTable("jobs")
      .set({
        status: "failed",
        locked_until: null,
        last_error: LEASE_EXHAUSTED,
      })
      .where("status", "=", "running")
      .where("locked_until", "<", sql<Date>`now()`)
      .where("attempts", ">=", MAX_ATTEMPTS)
      .where("kind", "in", kinds)
      .returning("id")
      .execute();
    await failEmails(
      trx,
      failed.map((f) => f.id),
      LEASE_EXHAUSTED,
    );
    return failed.length;
  });
}

// AC-9: the token source wrapped so a 401 gets one fresh token and one
// repeat; a credential Google still rejects trips the breaker.
export function googleCaller(token: TokenSource): JobContext["google"] {
  return async <T>(
    call: (token: string) => Promise<Result<T, GoogleCallError>>,
  ): Promise<Result<T, GoogleFailure>> => {
    const once = async (
      fresh: boolean,
    ): Promise<Result<T, GoogleCallError | "breaker">> => {
      const t = await token({ fresh });
      if (!t.ok) return err(t.error === "rejected" ? "breaker" : "retry");
      return call(t.value);
    };
    const first = await once(false);
    const result =
      !first.ok && first.error === "rejected" ? await once(true) : first;
    if (result.ok) return result;
    const e = result.error;
    // A second 401 in a row: the credential itself.
    return err(e === "rejected" ? "breaker" : e);
  };
}

export type JobsStep =
  | { readonly kind: "no_key" }
  | {
      readonly kind: "ran";
      readonly ran: number;
      readonly breaker: boolean;
      readonly failed: readonly string[];
    };

export type JobsDeps = {
  readonly handlers: Handlers;
  readonly config: () => Promise<GoogleMailConfig | null>;
  readonly fetch?: GoogleFetch;
  readonly mint?: MintToken;
  // The process clock, for the step's own time budget only.
  readonly clock?: () => number;
};

// AC-8, AC-9: the step. The exhausted lease sweep runs first; with no live
// GOOGLE key nothing is claimed and no attempt is spent. The budget is
// checked before each claim, so a claimed job is never left to the step
// timeout. A breaker stops the step for this tick.
export async function runJobs(
  conn: Kysely<DB>,
  deps: JobsDeps,
): Promise<JobsStep> {
  const kinds = JobKind.options.filter((k) => deps.handlers[k] !== undefined);
  await sweepExhausted(conn, kinds);
  const cfg = await deps.config();
  if (cfg === null) return { kind: "no_key" };
  const clock = deps.clock ?? Date.now;
  const started = clock();
  const fetchFn = deps.fetch ?? fetch;
  const ctx: JobContext = {
    cfg,
    fetch: fetchFn,
    google: googleCaller(
      googleAccessToken(
        cfg,
        deps.mint ?? ((creds) => mintAccessToken(creds, fetchFn)),
      ),
    ),
  };
  const failed: string[] = [];
  let ran = 0;
  while (ran < JOB_BUDGET && clock() - started < TIME_BUDGET_MS) {
    const job = await claimJob(conn, kinds);
    if (!job) break;
    ran += 1;
    const handler = deps.handlers[job.kind];
    const outcome = await runOne(conn, job, handler, ctx);
    if (outcome.status === "failed") failed.push(`${job.kind} ${job.id}`);
    if (outcome.breaker) return { kind: "ran", ran, breaker: true, failed };
  }
  return { kind: "ran", ran, breaker: false, failed };
}

async function runOne(
  conn: Kysely<DB>,
  job: ClaimedJob,
  handler: JobHandler | undefined,
  ctx: JobContext,
): Promise<{ readonly status: string; readonly breaker: boolean }> {
  try {
    return await conn.transaction().execute(async (trx) => {
      const outcome: JobOutcome = handler
        ? await handler(trx, job, ctx)
        : { kind: "final", error: UNEXPECTED };
      const status = await finishJob(trx, job, outcome);
      return { status, breaker: outcome.kind === "breaker" };
    });
  } catch (e) {
    // A bug or a database error: its message is logged, never stored (it
    // could echo data). The work rolled back; the attempt counts.
    console.error(
      `jobs: ${job.kind} ${job.id} threw: ${e instanceof Error ? e.message : String(e)}`,
    );
    const status = await conn
      .transaction()
      .execute((trx: Transaction<DB>) =>
        finishJob(trx, job, { kind: "retry", error: UNEXPECTED }),
      );
    return { status, breaker: false };
  }
}

// AC-8: the daily purge also drops done jobs older than 30 days. Failed
// jobs stay, as the record of what never went out.
export async function purgeDoneJobs(conn: Kysely<DB>): Promise<number> {
  const gone = await conn
    .deleteFrom("jobs")
    .where("status", "=", "done")
    .where("updated_at", "<", sql<Date>`now() - interval '30 days'`)
    .executeTakeFirst();
  return Number(gone.numDeletedRows);
}
