import "server-only";
import { z } from "zod";
import { routeEmail } from "@/lib/email-routing";
import {
  PortalResetAbortReason,
  PortalResetEvent,
  PortalResetSignInReason,
} from "@/lib/db-enums";
import {
  MAX_REPORT_FAILURES,
  MAX_REPORT_ROUTES,
  type ReportRoute,
  type ResetReport,
} from "@/lib/portal-reset/report-email";
import { audit } from "@/server/audit";
import type { DB } from "@/server/db/types";
import { composeResetReport } from "@/server/email/compose";
import { sendRaw } from "@/server/google/gmail";
import type { Kysely } from "kysely";
import { MAX_ATTEMPTS, type JobHandler, type JobOutcome } from "./runner";
import { GMAIL_RETRY, gmailRefused, UNREADABLE } from "./send-email";

// Spec 0023 AC-31, AC-29: the send_reset_report handler, worker only (it
// loads the renderer; the engine queues it in the transaction that finishes
// the run). The payload is the run id and nothing else: the address and the
// body are read here, at send time. There is no email_messages row, because
// the report belongs to no learner; a job that fails for good writes the
// permanent `portal_reset.report_failed` audit row instead.

export const reportPayload = z.object({ runId: z.uuid() });

const DONE: JobOutcome = { kind: "done" };

const RouteDetail = z.object({
  outcome: z.string().max(40),
  found: z.number(),
  deleted: z.number(),
  left: z.number(),
});

const counts = (raw: unknown): Readonly<Record<string, number>> => {
  const parsed = z.record(z.string(), z.number()).safeParse(raw);
  return parsed.success ? parsed.data : {};
};

const routeOf = (route: string | null, detail: unknown): ReportRoute | null => {
  const parsed = RouteDetail.safeParse(detail);
  return parsed.success ? { route, ...parsed.data } : null;
};

async function buildReport(
  trx: Kysely<DB>,
  runId: string,
): Promise<ResetReport | undefined> {
  const run = await trx
    .selectFrom("portal_reset_runs as r")
    .innerJoin("testbeds as t", "t.id", "r.testbed_id")
    .select([
      "r.event",
      "r.mode",
      "r.state",
      "r.abort_reason",
      "r.sign_in_reason",
      "r.lab_ended_at",
      "r.started_at",
      "r.finished_at",
      "r.counts",
      "t.name as testbed_name",
      "t.domain",
    ])
    .where("r.id", "=", runId)
    .executeTakeFirst();
  if (!run) return undefined;
  const failures = await trx
    .selectFrom("portal_reset_run_items")
    .select(["step_key", "label", "method", "route", "status", "message"])
    .where("run_id", "=", runId)
    .where("kind", "=", "failed")
    .where("resolved", "=", false)
    .orderBy("seq")
    .limit(MAX_REPORT_FAILURES)
    .execute();
  const routes = await trx
    .selectFrom("portal_reset_run_items")
    .select(["route", "detail"])
    .where("run_id", "=", runId)
    .where("kind", "=", "route_found")
    .orderBy("seq")
    .limit(MAX_REPORT_ROUTES)
    .execute();
  const total = counts(run.counts);
  const state = z
    .enum(["incomplete", "aborted", "done", "held"])
    .safeParse(run.state);
  return {
    testbedName: run.testbed_name,
    domain: run.domain ?? "",
    event: PortalResetEvent.parse(run.event),
    mode: run.mode === "dry_run" ? "dry_run" : "live",
    outcome: state.success ? state.data : "done",
    reason:
      run.abort_reason === null
        ? null
        : PortalResetAbortReason.parse(run.abort_reason),
    signInReason:
      run.sign_in_reason === null
        ? null
        : PortalResetSignInReason.parse(run.sign_in_reason),
    labEndedAt: run.lab_ended_at.toISOString(),
    startedAt: run.started_at?.toISOString() ?? null,
    finishedAt: run.finished_at?.toISOString() ?? null,
    counts: total,
    failures: failures.map((f) => ({
      stepKey: f.step_key,
      label: f.label,
      method: f.method,
      route: f.route,
      status: f.status,
      message: f.message,
    })),
    moreFailures: Math.max(0, (total.failed ?? 0) - failures.length),
    routes: routes.flatMap((r) => {
      const route = routeOf(r.route, r.detail);
      return route === null ? [] : [route];
    }),
  };
}

export const runSendResetReport: JobHandler = async (trx, job, ctx) => {
  const payload = reportPayload.safeParse(job.payload);
  if (!payload.success) return { kind: "final", error: UNREADABLE };
  const { runId } = payload.data;

  const failed = async (error: string): Promise<JobOutcome> => {
    await audit(trx, {
      actorUserId: null,
      action: "portal_reset.report_failed",
      targetType: "portal_reset_run",
      targetId: runId,
      summary: "The portal reset report email could not be sent",
      metadata: { error },
    });
    return { kind: "final", error };
  };

  // The address is read now, not copied at queue time (AC-31): a changed or
  // cleared address takes effect, and no address sits in a job row.
  const settings = await trx
    .selectFrom("portal_reset_settings")
    .select("abort_email")
    .executeTakeFirst();
  const address = settings?.abort_email ?? null;
  if (address === null) return DONE;
  const report = await buildReport(trx, runId);
  if (report === undefined) return DONE;

  // Test address routing applies (AC-31), but never the Ops BCC.
  const route = routeEmail(address, { ...ctx.cfg, opsBcc: null });
  if (route.kind === "suppress") return DONE;

  const { raw } = await composeResetReport({
    runId,
    report,
    senderEmail: ctx.cfg.senderEmail,
    to: route.to,
    subjectPrefix: route.subjectPrefix,
  });
  const sent = await ctx.google((t) => sendRaw(ctx.fetch, t, raw));
  if (sent.ok) return DONE;
  const e = sent.error;
  if (e === "breaker") return { kind: "breaker" };
  if (e === "retry") {
    return job.attempts >= MAX_ATTEMPTS
      ? failed(GMAIL_RETRY)
      : { kind: "retry", error: GMAIL_RETRY };
  }
  return failed(gmailRefused(e.status));
};
