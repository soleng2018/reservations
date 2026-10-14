import "server-only";
import { z } from "zod";
import { err, ok, type Result } from "@/lib/result";

// Cloudflare Access (spec 0012 AC-10, AC-11). The revoke ends every Access
// session the learner's email holds, so an open browser VM tab stops within
// about a minute instead of lasting until the Access session expires; the
// worker is its only caller. The token check runs in the web process when an
// admin saves a CLOUDFLARE API key. Nothing here ever logs or returns the
// token, the email, the request URL, or the response body.

// From the one live CLOUDFLARE API key: base URL
// https://api.cloudflare.com/client/v4/accounts/<account id>, and its secret.
export type CloudflareConfig = {
  readonly baseUrl: string;
  readonly apiToken: string;
};

// Where a reconciler run gets its revoke from (AC-11): no live CLOUDFLARE
// key (off), a key the worker can't read (broken), or a usable config (on).
export type RevokeSource =
  | { readonly kind: "off" }
  | { readonly kind: "broken" }
  | { readonly kind: "on"; readonly config: CloudflareConfig };

export type RevokeError =
  | "unavailable" // 429, 5xx, timeout, network: worth another try
  | "config" // 401, 403: the token or account is wrong
  | "rejected"; // any other non success: final for this learner

export type RevokeOptions = {
  readonly timeoutMs?: number;
};

const TIMEOUT_MS = 5000;
const Reply = z.object({ success: z.boolean() });

const discard = (res: Response) => res.body?.cancel().catch(() => undefined);

const headers = (config: CloudflareConfig) => ({
  Authorization: `Bearer ${config.apiToken}`,
  "Content-Type": "application/json",
});

// A 2xx whose body is `{ success: true }`; false for anything else,
// including a body that is not JSON.
const succeeded = async (res: Response): Promise<boolean> => {
  try {
    const reply = Reply.safeParse(await res.json());
    return reply.success && reply.data.success;
  } catch {
    return false;
  }
};

// One call, no retries.
export async function revokeAccessUser(
  config: CloudflareConfig,
  email: string,
  options: RevokeOptions = {},
): Promise<Result<void, RevokeError>> {
  let res: Response;
  try {
    res = await fetch(`${config.baseUrl}/access/organizations/revoke_user`, {
      method: "POST",
      headers: headers(config),
      body: JSON.stringify({ email }),
      signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
    });
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
  return (await succeeded(res)) ? ok(undefined) : err("rejected");
}

export type VerifyError =
  | "invalid" // any 4xx, or a 2xx without success: true
  | "unavailable"; // timeout, network, 5xx

// Save time check (spec 0006 AC-12): reading the Access organization proves
// in one call that the token is valid, belongs to that account, and can use
// Access, for user and account tokens alike.
export async function verifyCloudflareToken(
  config: CloudflareConfig,
  options: RevokeOptions = {},
): Promise<Result<void, VerifyError>> {
  let res: Response;
  try {
    res = await fetch(`${config.baseUrl}/access/organizations`, {
      method: "GET",
      headers: headers(config),
      signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
    });
  } catch {
    return err("unavailable");
  }
  if (res.status >= 500) {
    await discard(res);
    return err("unavailable");
  }
  if (!res.ok) {
    await discard(res);
    return err("invalid");
  }
  return (await succeeded(res)) ? ok(undefined) : err("invalid");
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
export function makeRevoker(
  config: CloudflareConfig,
  deps: RevokerDeps,
): VmRevoker {
  let tripped = false;
  const trip = (why: string): VmRevoke => {
    tripped = true;
    console.error(
      `cloudflare revoke: ${why}, skipping the rest of this run's revokes`,
    );
    return "failed";
  };
  const attempt = async (email: string, tries: number): Promise<VmRevoke> => {
    const r = await revokeAccessUser(config, email, deps);
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
