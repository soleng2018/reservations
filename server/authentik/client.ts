import "server-only";
// @goauthentik/api 2026.2.x ships an incomplete CommonJS build (no root
// index), so the complete ESM build is imported directly. Pinned to the
// deployed Authentik version (spec 0001).
import {
  Configuration,
  CoreApi,
  FetchError,
  PoliciesApi,
  ResponseError,
  type FetchAPI,
} from "@goauthentik/api/dist/esm/index.js";
import { err, ok, type Result } from "@/lib/result";
import { authentikEnv } from "@/server/env";

export { CoreApi };
export type {
  AuthenticatedSession,
  Group,
  User,
} from "@goauthentik/api/dist/esm/index.js";

export type AuthentikFailure = "unavailable" | "not_found";

const TIMEOUT_MS = 10_000;
const READ_ATTEMPTS = 3;

const isRead = (init?: RequestInit) =>
  (init?.method ?? "GET").toUpperCase() === "GET";

// Every request times out after 10 seconds (AC-15). Only safe reads retry,
// on a network error or a 5xx, so a write is never sent twice.
export const withTimeoutAndRetry =
  (base: FetchAPI, timeoutMs: number = TIMEOUT_MS): FetchAPI =>
  async (input, init) => {
    const attempts = isRead(init) ? READ_ATTEMPTS : 1;
    // One deadline for the whole call, retries included, so a hanging
    // Authentik costs at most timeoutMs, not timeoutMs per attempt.
    const signal = AbortSignal.timeout(timeoutMs);
    const tryOnce = async (left: number): Promise<Response> => {
      const res = await base(input, { ...init, signal }).catch((e: unknown) => {
        if (left > 1 && !signal.aborted) return undefined;
        throw e;
      });
      if (res && (res.status < 500 || left <= 1)) return res;
      return tryOnce(left - 1);
    };
    return tryOnce(attempts);
  };

// Spec 0026: the delete check reads policy bindings with the same token,
// timeout, and fetch as the core client. The policies client rides on the core
// client under a global symbol, not in module state: the runtime client is
// cached on globalThis and outlives a module reload (a dev hot reload, or a
// second bundle copy), so a module local map would lose it.
const POLICIES = Symbol.for("hol.authentik.policiesApi");
type WithPolicies = CoreApi & { [POLICIES]?: PoliciesApi };

export function createCoreApi(
  env: { readonly AUTHENTIK_URL: string; readonly token: string },
  fetchApi: FetchAPI = fetch,
): CoreApi {
  const configuration = new Configuration({
    basePath: `${env.AUTHENTIK_URL}/api/v3`,
    accessToken: env.token,
    fetchApi: withTimeoutAndRetry(fetchApi),
  });
  const api = new CoreApi(configuration);
  Object.defineProperty(api, POLICIES, {
    value: new PoliciesApi(configuration),
  });
  return api;
}

export function policiesApi(api: CoreApi): PoliciesApi {
  const policies = (api as WithPolicies)[POLICIES];
  // A bug, not an expected failure: every client comes from createCoreApi.
  if (!policies)
    throw new Error("policiesApi: client not made by createCoreApi");
  return policies;
}

const cache = globalThis as typeof globalThis & { holAuthentik?: CoreApi };

// The runtime client, using the provisioning token only (never the master).
export function authentik(): CoreApi {
  const env = authentikEnv();
  cache.holAuthentik ??= createCoreApi({
    AUTHENTIK_URL: env.AUTHENTIK_URL,
    token: env.AUTHENTIK_PROVISIONING_TOKEN,
  });
  return cache.holAuthentik;
}

// What an error status means for a group write (spec 0026 AC-4). Pure, so it
// is unit tested: a 400 is a refusal of the request itself (a name that
// exists or is not accepted), told apart from an outage.
export type WriteFailure = AuthentikFailure | "rejected";
export const classifyStatus = (status: number): WriteFailure =>
  status === 404 ? "not_found" : status === 400 ? "rejected" : "unavailable";

// Like `call`, for a write whose 400 the caller must tell from an outage.
export async function callWrite<T>(
  what: string,
  run: () => Promise<T>,
): Promise<Result<T, WriteFailure>> {
  try {
    return ok(await run());
  } catch (e) {
    if (e instanceof ResponseError) {
      const failure = classifyStatus(e.response.status);
      if (failure !== "not_found")
        console.error(`authentik: ${what} → ${e.response.status}`);
      return err(failure);
    }
    if (e instanceof FetchError) {
      console.error(`authentik: ${what} failed: ${e.cause.name}`);
      return err("unavailable");
    }
    throw e;
  }
}

// Runs one SDK call. Network errors, timeouts, and error statuses become a
// Result; a 404 is told apart. Logs the call name and status, never PII.
export async function call<T>(
  what: string,
  run: () => Promise<T>,
): Promise<Result<T, AuthentikFailure>> {
  try {
    return ok(await run());
  } catch (e) {
    if (e instanceof ResponseError) {
      if (e.response.status === 404) return err("not_found");
      console.error(`authentik: ${what} → ${e.response.status}`);
      return err("unavailable");
    }
    if (e instanceof FetchError) {
      console.error(`authentik: ${what} failed: ${e.cause.name}`);
      return err("unavailable");
    }
    throw e;
  }
}
