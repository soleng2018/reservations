import "server-only";
import type { Kysely } from "kysely";
import { err, type Result } from "@/lib/result";
import type { CoreApi } from "@/server/authentik/client";
import { issueSetPasswordLink } from "@/server/authentik/learners";
import { Refusal, refusable } from "@/server/db/refusal";
import type { DB } from "@/server/db/types";
import { countHourlyAttempt, hourlyCount } from "@/server/rate-limit";
import { endClickedLink, linkState } from "./set-password-links";

// Spec 0014 AC-10: the click on the app's own set password link, behind the
// `startSetPassword` Server Action. On success it answers the Authentik
// recovery link to redirect to, with `next` set to the app's own authorize
// request, so the learner comes back signed in (AC-11).

export type StartRefusal = "dead" | "already_set" | "unavailable" | "limited";

// AC-10 step 1: misses per IP per hour. Live clicks never count.
export const MISS_LIMIT = 30;
export const missKey = (ip: string) => `set-password:miss:${ip}`;

// AC-10 step 4: the Authentik link lives just long enough to open.
export const RECOVERY_DURATION = "minutes=10";

export type StartDeps = {
  readonly conn: Kysely<DB>;
  readonly api: CoreApi;
  readonly ip: string;
  // Starts the app's sign in (it sets the state cookie) and answers the
  // authorize URL, or undefined when sign in can't start.
  readonly startSignIn: () => Promise<string | undefined>;
};

export async function beginSetPassword(
  deps: StartDeps,
  token: string,
): Promise<Result<string, StartRefusal>> {
  const { conn, api, ip } = deps;
  const key = missKey(ip);
  if ((await hourlyCount(conn, key)) >= MISS_LIMIT) return err("limited");

  const seen = await linkState(conn, token);
  if (seen.view !== "live") {
    await countHourlyAttempt(conn, key, MISS_LIMIT);
    return err(seen.view);
  }

  return refusable<string, StartRefusal>(() =>
    conn.transaction().execute(async (trx) => {
      // The lock first pattern: user FOR SHARE, then the link FOR UPDATE.
      const now = await linkState(trx, token, { lock: true });
      if (now.view !== "live") throw new Refusal("dead");
      const { link } = now;

      // Guarded, while holding the locks. Unavailable keeps the link live.
      const recovery = await issueSetPasswordLink(
        api,
        link.authentikUserPk,
        RECOVERY_DURATION,
      );
      if (!recovery.ok)
        throw new Refusal(
          recovery.error === "unavailable" ? "unavailable" : "dead",
        );

      const authorizeUrl = await deps.startSignIn();
      if (authorizeUrl === undefined) throw new Refusal("unavailable");
      const target = new URL(recovery.value);
      const authorize = new URL(authorizeUrl);
      // Authentik follows only a relative `next`, so both must be one host.
      if (authorize.origin !== target.origin)
        throw new Error(
          `set password: the authorize origin ${authorize.origin} is not the recovery origin ${target.origin}; AUTHENTIK_URL and the issuer must name the same public host`,
        );

      await endClickedLink(trx, link);
      target.searchParams.set("next", authorize.pathname + authorize.search);
      return target.toString();
    }),
  );
}
