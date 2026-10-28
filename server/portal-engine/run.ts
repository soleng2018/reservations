import "server-only";
import type { Kysely } from "kysely";
import { z } from "zod";
import type { Result } from "@/lib/result";
import type {
  PortalResetAbortReason,
  PortalResetSignInReason,
} from "@/lib/db-enums";
import { holdsRun } from "@/lib/portal-reset/sign-in";
import { guards as guardFile } from "@/lib/portal-reset/guards";
import { readResetList, type ResetStep } from "@/server/portal-reset/steps";
import type { DB } from "@/server/db/types";
import { releaseRun, saveProgress, stopCheck, type ClaimedRun } from "./claim";
import {
  stepKeyOf,
  type ItemRecord,
  type StepEnv,
  type StepResult,
} from "./interpret";
import type { PortalClient } from "./portal";
import {
  computeProtected,
  guardedPortal,
  isGuardedWrite,
  NO_PROTECTION,
} from "./guards";
import {
  appendItems,
  finishRun,
  holdRun,
  type Counts,
  type GuardNote,
} from "./report";
import { GuardStop, SessionLost, Shutdown, StopRun } from "./stop";

// One run, start to finish (spec 0023 "Run algorithm"): claim, stop check,
// snapshot, sign in, four phases, one finish.
//
//   1  every enabled step, in order
//   2  the final re-read of each step that did not fail (a leftover fails it)
//   3  the second pass over the steps that failed
//   4  the final re-read of the steps the second pass finished
//
// There is no third pass (AC-19). A stop check runs before each step and
// before every write, and renews the lease. Progress is saved after each
// step (keys only), so a resumed run starts at the step it was in (AC-9).
// Item records are saved after each step too, so they outlive a crash. The
// parts that grow later are injected: the real sign in (task 9) and
// discovery (task 10, between phases 1 and 2).

export type RunDeps = {
  readonly conn: Kysely<DB>;
  // Sign in for the run's testbed (AC-12 to AC-16, AC-43). The error says
  // what the run does next; `sign_in` carries a closed reason.
  readonly signIn: (
    run: ClaimedRun,
  ) => Promise<Result<PortalClient, SignInError>>;
  readonly runStep: (step: ResetStep, env: StepEnv) => Promise<StepResult>;
  readonly recheckStep: (step: ResetStep, env: StepEnv) => Promise<boolean>;
  readonly shouldStop: () => boolean;
  readonly sleep?: (ms: number) => Promise<void>;
};

export type SignInError =
  | { readonly kind: "sign_in"; readonly reason: PortalResetSignInReason }
  | { readonly kind: "testbed_unavailable" }
  | { readonly kind: "tenant_mismatch" };

const Phase = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);

// What `progress` holds: the phase, the step keys finished in it, the keys
// that failed in phases 1 and 2, and the keys still bad after phases 3 and 4.
const Progress = z.object({
  phase: Phase,
  done: z.array(z.string()),
  failed: z.array(z.string()),
  bad: z.array(z.string()),
});
type Progress = z.infer<typeof Progress>;

const START: Progress = { phase: 1, done: [], failed: [], bad: [] };

export const readProgress = (raw: unknown): Progress => {
  const parsed = Progress.safeParse(raw);
  return parsed.success ? parsed.data : START;
};

const allGuardsByKey = (key: string) => guardFile.find((g) => g.key === key);

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const without = (keys: readonly string[], drop: readonly string[]) =>
  keys.filter((k) => !drop.includes(k));

// The steps a phase works on, from the saved progress.
const targets = (
  phase: Progress["phase"],
  p: Progress,
  steps: readonly ResetStep[],
): readonly ResetStep[] => {
  const keep = (key: string) =>
    phase === 1
      ? true
      : phase === 2
        ? !p.failed.includes(key)
        : phase === 3
          ? p.failed.includes(key)
          : p.failed.includes(key) && !p.bad.includes(key);
  return steps.filter((s) => keep(stepKeyOf(s)));
};

export async function executeRun(
  run: ClaimedRun,
  deps: RunDeps,
): Promise<void> {
  const { conn } = deps;
  const abort = (
    reason: PortalResetAbortReason,
    c: Counts,
    guard?: GuardNote,
  ) =>
    finishRun(conn, run.id, {
      kind: "aborted",
      reason,
      counts: c,
      ...(guard === undefined ? {} : { guard }),
    }).then(() => undefined);

  const first = await stopCheck(conn, run.id);
  if (first === "lost") return;
  if (first !== "go") return abort(first, {});

  const list = await readResetList(conn);
  if (list.mode === "off") return abort("mode_off", {});
  const parsed = list.steps.flatMap((s) => (s.ok ? [s.step] : []));
  if (parsed.length !== list.steps.length) return abort("invalid_list", {});
  const steps = parsed.filter((s) => s.enabled);
  const skippedSteps = list.steps.length - steps.length;

  const signedIn = await deps.signIn(run);
  if (!signedIn.ok) {
    const failure = signedIn.error;
    if (failure.kind !== "sign_in") return abort(failure.kind, {});
    // AC-14: a failure no retry can fix holds the run; the rest end it.
    if (holdsRun(failure.reason)) {
      await holdRun(conn, run.id, failure.reason);
      return;
    }
    return finishRun(conn, run.id, {
      kind: "aborted",
      reason: "sign_in_failed",
      counts: {},
      signIn: failure.reason,
    }).then(() => undefined);
  }
  const raw = signedIn.value;
  const sleep = deps.sleep ?? wait;
  const records: ItemRecord[] = [];
  const flush = () => appendItems(conn, run.id, records.splice(0));
  const dry = run.mode === "dry_run";
  let progress = readProgress(run.progress);
  // The step in hand, for a guard stop's audit row (a readable name).
  let stepName: string | null = "guards";
  try {
    const found = await computeProtected(
      guardedPortal(raw, NO_PROTECTION),
      sleep,
    );
    if (!found.ok) {
      const guard = allGuardsByKey(found.error.guardKey);
      return abort(
        "guard_stop",
        {},
        {
          stepKey: "guards",
          route: guard?.listPath ?? "/api/",
        },
      );
    }
    const env: StepEnv = {
      portal: guardedPortal(raw, found.value),
      mode: run.mode,
      pass: 1,
      sleep,
      beforeWrite: async () => {
        // The call in flight has finished; no new write starts (AC-10).
        if (deps.shouldStop()) throw new Shutdown();
        const stop = await stopCheck(conn, run.id);
        if (stop !== "go") throw new StopRun(stop);
      },
      isGuarded: isGuardedWrite(found.value),
      record: (r) => records.push(r),
      hidden: new Set(),
    };

    for (const phase of [1, 2, 3, 4] as const) {
      if (phase < progress.phase) continue;
      // Nothing was written in a dry run, so there is nothing to re-read.
      const skip = dry && (phase === 2 || phase === 4);
      for (const step of skip ? [] : targets(phase, progress, steps)) {
        const key = stepKeyOf(step);
        if (progress.done.includes(key)) continue;
        if (deps.shouldStop()) throw new Shutdown();
        const stop = await stopCheck(conn, run.id);
        if (stop === "lost") return;
        if (stop !== "go") throw new StopRun(stop);
        stepName = step.seedKey ?? step.featureName;
        const stepEnv = phase <= 2 ? env : { ...env, pass: 2 as const };
        const clean =
          phase === 1 || phase === 3
            ? (await deps.runStep(step, stepEnv)) === "done"
            : await deps.recheckStep(step, stepEnv);
        progress = {
          ...progress,
          done: [...progress.done, key],
          failed:
            phase <= 2 && !clean ? [...progress.failed, key] : progress.failed,
          bad: phase >= 3 && !clean ? [...progress.bad, key] : progress.bad,
        };
        await flush();
        await saveProgress(conn, run.id, progress);
      }
      progress = {
        ...progress,
        phase: phase === 4 ? 4 : ((phase + 1) as 2 | 3 | 4),
        done: [],
      };
      // Phase 3 and 4 exist only for steps that failed.
      if (phase === 2 && progress.failed.length === 0) break;
    }

    await finishRun(conn, run.id, {
      kind: progress.bad.length === 0 ? "done" : "incomplete",
      mode: run.mode,
      counts: {
        steps: steps.length,
        failedSteps: progress.bad.length,
        skippedSteps,
      },
      resolvedSteps: without(progress.failed, progress.bad),
    });
  } catch (e) {
    if (e instanceof Shutdown) {
      await flush();
      await releaseRun(conn, run.id, progress);
      return;
    }
    if (!(e instanceof StopRun)) throw e;
    if (e.reason === "lost") return;
    await flush();
    if (e instanceof SessionLost) {
      return finishRun(conn, run.id, {
        kind: "aborted",
        reason: "sign_in_failed",
        counts: {},
        signIn: e.signInReason,
      }).then(() => undefined);
    }
    return e instanceof GuardStop
      ? abort("guard_stop", {}, { stepKey: stepName, route: e.route })
      : abort(e.reason, {});
  } finally {
    await raw.close();
  }
}
