import "server-only";
import { generateKeyPairSync } from "node:crypto";
import type { GoogleServiceAccountKey } from "@/lib/booking-email";
import type { GoogleFetch } from "./http";
import type { ServiceAccountCredentials } from "./token";

// Test support only (spec 0013): a service account key file and an OAuth
// client file shaped like the ones Google Cloud downloads, an id_token like
// Google's, and a fake fetch that answers from a script and records every
// request. Never used by app code.

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

// The worker's credentials for that key file (AC-30).
export const serviceAccountCredentials = (
  key = fakeServiceAccountKey(),
): ServiceAccountCredentials => ({
  method: "service_account",
  clientEmail: key.client_email,
  privateKey: key.private_key,
  privateKeyId: key.private_key_id,
});

export const FAKE_CLIENT_ID =
  "123456789012-abcdefghijklmnopqrstuvwxyz012345.apps.googleusercontent.com";

// A Desktop app OAuth client file (AC-26), with the fields this app ignores.
export const fakeOAuthClientText = (
  overrides: {
    readonly clientId?: string;
    readonly clientSecret?: string;
  } = {},
) =>
  JSON.stringify({
    installed: {
      client_id: overrides.clientId ?? FAKE_CLIENT_ID,
      project_id: "hol-gmail-test",
      auth_uri: "https://accounts.google.com/o/oauth2/auth",
      token_uri: "https://oauth2.googleapis.com/token",
      client_secret: overrides.clientSecret ?? "GOCSPX-test-client-secret",
      redirect_uris: ["http://localhost"],
    },
  });

// An id_token as Google's token endpoint returns it; the signature part is
// a stand in, since the app never checks it (AC-28 step 7).
export const fakeIdToken = (payload: Record<string, unknown>) =>
  [
    Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString(
      "base64url",
    ),
    Buffer.from(
      JSON.stringify({
        iss: "https://accounts.google.com",
        aud: FAKE_CLIENT_ID,
        sub: "1098765432109876543210",
        email: "hol.sender@gmail.com",
        email_verified: true,
        ...payload,
      }),
    ).toString("base64url"),
    "signature",
  ].join(".");

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
