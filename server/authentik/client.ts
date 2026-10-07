import "server-only";
// @goauthentik/api 2026.2.x ships an incomplete CommonJS build (no root
// index), so the complete ESM build is imported directly. Pinned to the
// deployed Authentik version (spec 0001).
import {
  Configuration,
  CoreApi,
  FetchError,
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
  (base: FetchAPI): FetchAPI =>
  async (input, init) => {
    const attempts = isRead(init) ? READ_ATTEMPTS : 1;
    const tryOnce = async (left: number): Promise<Response> => {
      const res = await base(input, {
        ...init,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }).catch((e: unknown) => {
        if (left > 1) return undefined;
        throw e;
      });
      if (res && (res.status < 500 || left <= 1)) return res;
      return tryOnce(left - 1);
    };
    return tryOnce(attempts);
  };

export function createCoreApi(
  env: { readonly AUTHENTIK_URL: string; readonly token: string },
  fetchApi: FetchAPI = fetch,
): CoreApi {
  return new CoreApi(
    new Configuration({
      basePath: `${env.AUTHENTIK_URL}/api/v3`,
      accessToken: env.token,
      fetchApi: withTimeoutAndRetry(fetchApi),
    }),
  );
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
