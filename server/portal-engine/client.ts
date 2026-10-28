import "server-only";
import { isDenied } from "@/lib/portal-reset/deny-list";
import { routePattern } from "@/lib/portal-reset/route-pattern";
import { CALL_TIMEOUT, MAX_REPLY_BYTES } from "@/lib/portal-reset/timing";
import { err, ok, type Result } from "@/lib/result";
import type {
  CallError,
  PortalClient,
  PortalReply,
  PortalRequest,
} from "./portal";
import type { Secret } from "./secret";
import { GuardStop } from "./stop";

// The real portal client and the one place a request leaves the engine (spec
// 0023 AC-25). It sends only to the session's own origin and only under
// `/api/`, never to a denied path, never follows a redirect, gives up after
// 20 seconds, and reads at most 5 MB. The three sign in headers live in a
// `Secret` and are revealed here and nowhere else. A request that breaks a
// rule is refused before anything is sent (a `GuardStop`), because it means a
// bug or a bad list, not a portal answer.

export type Session = {
  readonly origin: string;
  // `x-id-token`, `x-nile-client`, `x-requested-with` (AC-13).
  readonly headers: Secret<Readonly<Record<string, string>>>;
  // How calls are sent. The real sign in gives its browser context's client.
  readonly fetch?: typeof fetch;
  readonly close: () => Promise<void>;
};

type FetchImpl = typeof fetch;

const isAbort = (e: unknown): boolean =>
  e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");

// The body as text up to the cap, or null when it is larger.
async function readCapped(res: Response): Promise<string | null> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > MAX_REPLY_BYTES) {
    await res.body?.cancel();
    return null;
  }
  if (res.body === null) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_REPLY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// Only the parsed JSON leaves; the text is dropped, so a reply that is not
// JSON (a login page, an error page) carries no message (AC-30).
const parseBody = (text: string): unknown => {
  try {
    return text === "" ? undefined : (JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
};

export function makePortalClient(
  session: Session,
  fetchImpl: FetchImpl = session.fetch ?? fetch,
): PortalClient {
  const urlFor = (path: string): URL => {
    if (isDenied(path) || !path.startsWith("/api/")) {
      throw new GuardStop(routePattern(path));
    }
    const url = new URL(path, session.origin);
    if (url.origin !== session.origin) {
      throw new GuardStop(routePattern(path));
    }
    return url;
  };

  const call = async (
    req: PortalRequest,
  ): Promise<Result<PortalReply, CallError>> => {
    const url = urlFor(req.path);
    try {
      const res = await fetchImpl(url, {
        method: req.method,
        redirect: "manual",
        signal: AbortSignal.timeout(CALL_TIMEOUT),
        headers: {
          accept: "application/json",
          ...(req.body === undefined
            ? {}
            : { "content-type": "application/json" }),
          ...session.headers.reveal(),
        },
        ...(req.body === undefined ? {} : { body: JSON.stringify(req.body) }),
      });
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel();
        return err("redirect");
      }
      const text = await readCapped(res);
      return text === null
        ? err("oversize")
        : ok({ status: res.status, body: parseBody(text) });
    } catch (e) {
      return err(isAbort(e) ? "timeout" : "network");
    }
  };

  return { call, close: session.close };
}
