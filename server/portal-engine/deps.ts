import "server-only";
import { setTimeout as pause } from "node:timers/promises";
import type { Kysely } from "kysely";
import { authentik } from "@/server/authentik/client";
import type { DB } from "@/server/db/types";
import { coveredRoutes } from "@/lib/portal-reset/discovery-rules";
import { connect, hasBrowser } from "./connect";
import { makeBrowserCollector, runDiscovery } from "./discovery";
import { recheckStep, runStep } from "./interpret";
import type { RunDeps } from "./run";
import { signIn } from "./sign-in";

// The run's real dependencies: the browser sign in, the Authentik account,
// and the interpreter. A mode of `off` never reaches this (the claim and the
// stop check end the run first).
export const realRunDeps = (
  conn: Kysely<DB>,
  shouldStop: () => boolean,
): RunDeps => ({
  conn,
  signIn: connect({
    conn,
    api: authentik(),
    browserSignIn: (input) => signIn(input),
    sleep: (ms) => pause(ms),
  }),
  runStep,
  recheckStep,
  shouldStop,
  discover: async (portal, env, steps) => {
    if (!hasBrowser(portal)) return { failed: false, counts: {} };
    const open = portal.signedIn();
    const started = performance.now();
    return runDiscovery({
      collect: makeBrowserCollector(
        open.browser,
        open.state,
        open.session.origin,
      ),
      env,
      pages: steps.flatMap((s) => s.definition.pages ?? []),
      covered: coveredRoutes(steps.map((s) => s.definition)),
      elapsedMs: () => performance.now() - started,
    });
  },
});
