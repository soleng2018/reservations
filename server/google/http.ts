import "server-only";
import { err, ok, type Result } from "@/lib/result";

// Spec 0013: every Google call has a 10 second timeout, and the fetch is
// injected so tests use a fake.

export const GOOGLE_TIMEOUT_MS = 10_000;

export type GoogleFetch = typeof fetch;

// A timeout or a network error is "network"; any HTTP reply is returned as
// is for the caller to classify. Its body is never logged or stored (it can
// echo request data).
export async function googleRequest(
  fetchFn: GoogleFetch,
  url: string,
  init: RequestInit & { readonly token: string },
): Promise<Result<Response, "network">> {
  const { token, headers, ...rest } = init;
  try {
    return ok(
      await fetchFn(url, {
        ...rest,
        headers: { ...headers, Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
      }),
    );
  } catch {
    return err("network");
  }
}

// Calendar ids can hold `@` and `#`.
export const calendarPath = (calendarId: string) =>
  `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}`;

// Spec 0013 AC-15, AC-19: how a Gmail or Calendar call failed. "rejected"
// (a 401) is for the caller to retry once with a fresh token, then trip the
// breaker; "retry" backs off; "final" fails the job.
export type GoogleCallError =
  "rejected" | "retry" | { readonly kind: "final"; readonly status: number };

// A non 2xx reply's status, classified. 2xx is the caller's to read.
export const classifyStatus = (status: number): GoogleCallError =>
  status === 401
    ? "rejected"
    : status === 429 || status >= 500
      ? "retry"
      : { kind: "final", status };
