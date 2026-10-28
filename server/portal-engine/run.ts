import "server-only";
import type { Kysely } from "kysely";
import type { Result } from "@/lib/result";
import type { PortalResetAbortReason } from "@/lib/db-enums";
import { readResetList, type ResetStep } from "@/server/portal-reset/steps";
import type { DB } from "@/server/db/types";
import { releaseRun, stopCheck, type ClaimedRun } from "./claim";
import type { ItemRecord, StepEnv, StepResult } from "./interpret";
import type { PortalClient } from "./portal";
import { finishRun, type Counts } from "./report";
import { StopRun } from "./stop";

// One run, start to finish (spec 0023 "Run algorithm"): claim, stop check,
// snapshot, sign in, the enabled steps in order with a stop check before each
// step and before every write, one finish. The parts that grow later are
// injected: the real sign in (task 9), the guards (task 5), the passes and
// discovery (tasks 6 and 10).

export type RunDeps = {
  readonly conn: Kysely<DB>;
  // Sign in for the run's testbed; the error is a closed sign in reason.
  readonly signIn: (
    run: ClaimedRun,
  ) => Promise<Result<PortalClient, "sign_in_failed">>;
  readonly runStep: (step: ResetStep, env: StepEnv) => Promise<StepResult>;
  readonly shouldStop: () => boolean;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly isGuarded?: StepEnv["isGuarded"];
};

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const countRecords = (records: readonly ItemRecord[]): Counts =>
  records.reduce<Record<string, number>>(
    (acc, r) => ({ ...acc, [r.kind]: (acc[r.kind] ?? 0) + 1 }),
    {},
  );

export async function executeRun(
  run: ClaimedRun,
  deps: RunDeps,
): Promise<void> {
  const { conn } = deps;
  const abort = (reason: PortalResetAbortReason, c: Counts) =>
    finishRun(conn, run.id, { kind: "aborted", reason, counts: c }).then(
      () => undefined,
    );

  const first = await stopCheck(conn, run.id);
  if (first === "lost") return;
  if (first !== "go") return abort(first, {});

  const list = await readResetList(conn);
  if (list.mode === "off") return abort("mode_off", {});
  const parsed = list.steps.flatMap((s) => (s.ok ? [s.step] : []));
  if (parsed.length !== list.steps.length) return abort("invalid_list", {});
  const steps = parsed.filter((s) => s.enabled);

  const signedIn = await deps.signIn(run);
  if (!signedIn.ok) return abort("sign_in_failed", {});
  const portal = signedIn.value;
  const records: ItemRecord[] = [];
  const env: StepEnv = {
    portal,
    mode: run.mode,
    pass: 1,
    sleep: deps.sleep ?? wait,
    beforeWrite: async () => {
      const stop = await stopCheck(conn, run.id);
      if (stop !== "go") throw new StopRun(stop);
    },
    isGuarded: deps.isGuarded ?? (() => false),
    record: (r) => records.push(r),
    hidden: new Set(),
  };
  try {
    const results: StepResult[] = [];
    for (const step of steps) {
      if (deps.shouldStop()) {
        await releaseRun(conn, run.id, { doneSteps: results.length });
        return;
      }
      const stop = await stopCheck(conn, run.id);
      if (stop === "lost") return;
      if (stop !== "go") return abort(stop, { steps: results.length });
      results.push(await deps.runStep(step, env));
    }
    const failed = results.filter((r) => r === "failed").length;
    await finishRun(conn, run.id, {
      kind: failed === 0 ? "done" : "incomplete",
      mode: run.mode,
      counts: {
        steps: results.length,
        failedSteps: failed,
        skippedSteps: list.steps.length - steps.length,
        ...countRecords(records),
      },
    });
  } catch (e) {
    if (!(e instanceof StopRun)) throw e;
    if (e.reason === "lost") return;
    return abort(e.reason, { ...countRecords(records) });
  } finally {
    await portal.close();
  }
}
