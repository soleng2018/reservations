import "server-only";
import { setTimeout as pause } from "node:timers/promises";
import type { Kysely } from "kysely";
import { authentik } from "@/server/authentik/client";
import type { DB } from "@/server/db/types";
import { connect } from "./connect";
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
});
