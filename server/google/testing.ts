import "server-only";
import { generateKeyPairSync } from "node:crypto";
import type { GoogleServiceAccountKey } from "@/lib/booking-email";
import type { GoogleFetch } from "./http";

// Test support only (spec 0013): a service account key file shaped like the
// one Google Cloud downloads, and a fake fetch that answers from a script
// and records every request. Never used by app code.

// One RSA key per test process: generating it is slow.
let pem: string | undefined;
const privateKeyPem = () =>
  (pem ??= generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString());

export const fakeServiceAccountKey = (
  overrides: Partial<GoogleServiceAccountKey> = {},
): GoogleServiceAccountKey => ({
  type: "service_account",
  client_id: "104857600123456789012",
  client_email: "hol-mailer@hol-project.iam.gserviceaccount.com",
  private_key: privateKeyPem(),
  private_key_id: "0123456789abcdef0123456789abcdef01234567",
  ...overrides,
});

// The file as uploaded, with the fields this app ignores.
export const fakeKeyFileText = (key = fakeServiceAccountKey()) =>
  JSON.stringify({
    ...key,
    project_id: "hol-project",
    auth_uri: "https://accounts.google.com/o/oauth2/auth",
    token_uri: "https://oauth2.googleapis.com/token",
    universe_domain: "googleapis.com",
  });

export type RecordedRequest = {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | undefined;
};

// An answer is a status with an optional JSON body, or "network" to throw
// as fetch does on a timeout or a refused connection.
export type FakeAnswer =
  { readonly status: number; readonly json?: unknown } | "network";

export function fakeGoogleFetch(answer: (req: RecordedRequest) => FakeAnswer): {
  readonly fetch: GoogleFetch;
  readonly requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const fakeFetch = async (
    input: Parameters<GoogleFetch>[0],
    init?: Parameters<GoogleFetch>[1],
  ) => {
    const req: RecordedRequest = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    requests.push(req);
    const a = answer(req);
    if (a === "network") throw new TypeError("fetch failed");
    return new Response(a.json === undefined ? null : JSON.stringify(a.json), {
      status: a.status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch: fakeFetch, requests };
}
