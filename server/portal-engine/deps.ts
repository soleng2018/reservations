import "server-only";
import type { Kysely } from "kysely";
import { err } from "@/lib/result";
import type { DB } from "@/server/db/types";
import { recheckStep, runStep } from "./interpret";
import type { RunDeps } from "./run";

// The run's real dependencies. Until the real sign in lands (spec 0023 task
// 9), a claimed run ends `sign_in_failed` before any portal call, so turning
// the mode on early cannot reach a portal.
export const realRunDeps = (
  conn: Kysely<DB>,
  shouldStop: () => boolean,
): RunDeps => ({
  conn,
  signIn: async () => err("sign_in_failed"),
  runStep,
  recheckStep,
  shouldStop,
});
