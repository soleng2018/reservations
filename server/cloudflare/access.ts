import "server-only";
import { z } from "zod";
import { err, ok, type Result } from "@/lib/result";
import type { CloudflareEnv } from "@/server/env";

// Cloudflare Access revoke (spec 0012 AC-10): ends every Access session the
// learner's email holds, so an open browser VM tab stops at once instead of
// at the 1 hour Access backstop. Worker only. Nothing here ever logs or
// returns the token, the email, the request URL, or the response body.

export type RevokeError =
  | "unavailable" // 429, 5xx, timeout, network: worth another try
  | "config" // 401, 403: the token or account is wrong
  | "rejected"; // any other non success: final for this learner

export type RevokeOptions = {
  readonly baseUrl?: string; // a local stub in tests
  readonly timeoutMs?: number;
};

const API_BASE = "https://api.cloudflare.com/client/v4";
const TIMEOUT_MS = 5000;
const Reply = z.object({ success: z.boolean() });

const discard = (res: Response) => res.body?.cancel().catch(() => undefined);

// One call, no retries.
export async function revokeAccessUser(
  env: CloudflareEnv,
  email: string,
  options: RevokeOptions = {},
): Promise<Result<void, RevokeError>> {
  const base = options.baseUrl ?? API_BASE;
  let res: Response;
  try {
    res = await fetch(
      `${base}/accounts/${env.accountId}/access/organizations/revoke_user`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email }),
        signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
      },
    );
  } catch {
    return err("unavailable"); // network error or timeout
  }
  if (res.status === 429 || res.status >= 500) {
    await discard(res);
    return err("unavailable");
  }
  if (res.status === 401 || res.status === 403) {
    await discard(res);
    return err("config");
  }
  if (!res.ok) {
    await discard(res);
    return err("rejected");
  }
  try {
    const reply = Reply.safeParse(await res.json());
    return reply.success && reply.data.success
      ? ok(undefined)
      : err("rejected");
  } catch {
    return err("rejected"); // a 2xx whose body is not JSON
  }
}

export type VmRevoke = "done" | "failed";

// null: the learner has no users row, so there is no email to revoke.
export type VmRevoker = (email: string | null) => Promise<VmRevoke>;

// The waits before the second and the third try.
export const RETRY_DELAYS_MS: readonly number[] = [2000, 5000];

export type RevokerDeps = RevokeOptions & {
  readonly sleep: (ms: number) => Promise<unknown>;
};

// One revoker per reconciler run. It owns the retries and the breaker in its
// own closure: after a 401 or 403, or a learner whose every try was
// unavailable, each later call in this run is `failed` with no request. The
// caller logs each failed learner by id; this logs only why the breaker
// tripped.
export function makeRevoker(env: CloudflareEnv, deps: RevokerDeps): VmRevoker {
  let tripped = false;
  const trip = (why: string): VmRevoke => {
    tripped = true;
    console.error(
      `cloudflare revoke: ${why}, skipping the rest of this run's revokes`,
    );
    return "failed";
  };
  const attempt = async (email: string, tries: number): Promise<VmRevoke> => {
    const r = await revokeAccessUser(env, email, deps);
    if (r.ok) return "done";
    switch (r.error) {
      case "config":
        return trip("Cloudflare refused the token (401 or 403)");
      case "rejected":
        return "failed";
      case "unavailable": {
        const delay = RETRY_DELAYS_MS[tries - 1];
        if (delay === undefined)
          return trip(`Cloudflare unavailable after ${tries} tries`);
        await deps.sleep(delay);
        return attempt(email, tries + 1);
      }
      default: {
        const never: never = r.error;
        throw new Error(`unknown revoke error: ${String(never)}`);
      }
    }
  };
  return async (email) => {
    if (email === null || tripped) return "failed";
    return attempt(email, 1);
  };
}
