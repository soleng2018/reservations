import "server-only";

// The worker's tick (spec 0004 AC-11): steps run one after another, each with
// its own timeout. One failing step is logged and never stops the others.

export type Step = {
  readonly name: string;
  readonly run: () => Promise<unknown>;
};

export type StepOutcome =
  | { readonly name: string; readonly ok: true }
  | { readonly name: string; readonly ok: false; readonly error: string };

export const STEP_TIMEOUT_MS = 60_000;
export const TICK_PAUSE_MS = 30_000;
export const PURGE_EVERY_MS = 24 * 60 * 60 * 1000;
// pg_try_advisory_lock key for "only one worker" ("HOLW" in ASCII).
export const WORKER_LOCK_KEY = 0x484f4c57;

class StepTimeout extends Error {}

// Rejects after `ms`. The step itself cannot be cancelled (a query or HTTP
// call already sent), so it may finish in the background; the next step
// starts anyway.
export function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new StepTimeout(`timed out after ${ms} ms`)),
      ms,
    );
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

// Runs the steps in order. `shouldStop` is checked before each step, so a
// SIGTERM lets the current step finish and skips the rest.
export async function runTick(
  steps: readonly Step[],
  opts: {
    readonly timeoutMs: number;
    readonly shouldStop: () => boolean;
    readonly log: (line: string) => void;
  },
): Promise<readonly StepOutcome[]> {
  const outcomes: StepOutcome[] = [];
  for (const step of steps) {
    if (opts.shouldStop()) break;
    try {
      await withTimeout(step.run(), opts.timeoutMs);
      outcomes.push({ name: step.name, ok: true });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      opts.log(`worker: step ${step.name} failed: ${error}`);
      outcomes.push({ name: step.name, ok: false, error });
    }
  }
  return outcomes;
}

// Is the daily purge due? Pure, so the loop keeps the last run time itself.
export const purgeDue = (lastPurge: number | undefined, now: number) =>
  lastPurge === undefined || now - lastPurge >= PURGE_EVERY_MS;
