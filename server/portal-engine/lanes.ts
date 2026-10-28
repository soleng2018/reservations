import "server-only";
import { IDLE_PAUSE } from "@/lib/portal-reset/timing";
import type { ClaimedRun } from "./claim";

// The run lanes (spec 0023 AC-5, AC-11): N loops of claim, execute, pause
// when idle. They run beside the worker tick, not inside it. A lane that
// fails logs and goes on; the run's lease expires and any lane resumes it.
export type LaneDeps = {
  readonly claim: () => Promise<ClaimedRun | undefined>;
  readonly execute: (run: ClaimedRun) => Promise<void>;
  readonly pause: (ms: number) => Promise<void>;
  readonly log: (line: string) => void;
};

export async function runLanes(
  deps: LaneDeps,
  opts: { readonly lanes: number; readonly shouldStop: () => boolean },
): Promise<void> {
  const lane = async (n: number): Promise<void> => {
    while (!opts.shouldStop()) {
      const worked = await deps
        .claim()
        .then(async (run) => {
          if (!run) return false;
          await deps.execute(run);
          return true;
        })
        .catch((e: unknown) => {
          // Name only: the message could carry portal text (AC-30).
          deps.log(
            `portal reset lane ${n}: ${e instanceof Error ? e.name : "error"}`,
          );
          return false;
        });
      if (!worked && !opts.shouldStop()) await deps.pause(IDLE_PAUSE);
    }
  };
  await Promise.all(Array.from({ length: opts.lanes }, (_, i) => lane(i + 1)));
}
