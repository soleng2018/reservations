import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeRevoker,
  revokeAccessUser,
  verifyCloudflareToken,
  type CloudflareConfig,
} from "./access";

vi.mock("server-only", () => ({}));

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const TOKEN = "cf-token-do-not-log";
const ACCOUNT_PATH = `/client/v4/accounts/${ACCOUNT}`;
const EMAIL = "learner-secret@example.test";

type Seen = {
  readonly method: string;
  readonly url: string;
  readonly auth: string;
  readonly body: string;
};

// A stub Cloudflare API: replies with each scripted answer in turn (the last
// one repeats); "hang" never replies.
type Answer = { readonly status: number; readonly body?: string } | "hang";

let server: Server;
let origin: string;
let config: CloudflareConfig;
let seen: Seen[];
let script: readonly Answer[];

beforeEach(async () => {
  seen = [];
  script = [{ status: 200, body: '{"success":true}' }];
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      seen.push({
        method: req.method ?? "",
        url: req.url ?? "",
        auth: req.headers.authorization ?? "",
        body,
      });
      const answer = script[Math.min(seen.length, script.length) - 1];
      if (answer === undefined || answer === "hang") return;
      res.writeHead(answer.status, { "Content-Type": "application/json" });
      res.end(answer.body ?? '{"success":false}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // The stub stands in for https://api.cloudflare.com (spec 0012 AC-11).
  config = { baseUrl: `${origin}${ACCOUNT_PATH}`, apiToken: TOKEN };
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  vi.restoreAllMocks();
});

const revoke = (timeoutMs = 2000) =>
  revokeAccessUser(config, EMAIL, { timeoutMs });

// covers: AC-10, AC-11
describe("revokeAccessUser", () => {
  it("posts the email with the bearer token and is ok on success", async () => {
    expect(await revoke()).toEqual({ ok: true, value: undefined });
    expect(seen).toEqual([
      {
        method: "POST",
        url: `${ACCOUNT_PATH}/access/organizations/revoke_user`,
        auth: `Bearer ${TOKEN}`,
        body: JSON.stringify({ email: EMAIL }),
      },
    ]);
  });

  it.each([
    [429, "unavailable"],
    [503, "unavailable"],
    [401, "config"],
    [403, "config"],
    [400, "rejected"],
    [404, "rejected"],
  ] as const)("answers %i as %s", async (status, error) => {
    script = [{ status }];
    expect(await revoke()).toEqual({ ok: false, error });
  });

  it("is rejected for a 2xx without success: true", async () => {
    script = [{ status: 200, body: '{"success":false}' }];
    expect(await revoke()).toEqual({ ok: false, error: "rejected" });
    script = [{ status: 200, body: "not json" }];
    expect(await revoke()).toEqual({ ok: false, error: "rejected" });
  });

  it("is unavailable on a timeout or a network error", async () => {
    script = ["hang"];
    expect(await revoke(50)).toEqual({ ok: false, error: "unavailable" });
    expect(
      await revokeAccessUser(
        { baseUrl: `http://127.0.0.1:1${ACCOUNT_PATH}`, apiToken: TOKEN },
        EMAIL,
      ),
    ).toEqual({ ok: false, error: "unavailable" });
  });
});

// covers: AC-11 (spec 0006 AC-12, the save time check)
describe("verifyCloudflareToken", () => {
  const verify = (timeoutMs = 2000) =>
    verifyCloudflareToken(config, { timeoutMs });

  it("reads the Access organization with the bearer token", async () => {
    expect(await verify()).toEqual({ ok: true, value: undefined });
    expect(seen).toEqual([
      {
        method: "GET",
        url: `${ACCOUNT_PATH}/access/organizations`,
        auth: `Bearer ${TOKEN}`,
        body: "",
      },
    ]);
  });

  it.each([
    [403, "invalid"],
    [400, "invalid"],
    [401, "invalid"],
    [503, "unavailable"],
  ] as const)("answers %i as %s", async (status, error) => {
    script = [{ status }];
    expect(await verify()).toEqual({ ok: false, error });
  });

  it("is invalid for a 2xx without success: true", async () => {
    script = [{ status: 200, body: '{"success":false}' }];
    expect(await verify()).toEqual({ ok: false, error: "invalid" });
  });

  it("is unavailable on a timeout or a network error", async () => {
    script = ["hang"];
    expect(await verify(50)).toEqual({ ok: false, error: "unavailable" });
    expect(
      await verifyCloudflareToken({
        baseUrl: `http://127.0.0.1:1${ACCOUNT_PATH}`,
        apiToken: TOKEN,
      }),
    ).toEqual({ ok: false, error: "unavailable" });
  });

  it("never puts the token or the URL in its result", async () => {
    script = [{ status: 403, body: `{"errors":["${TOKEN}"]}` }];
    const result = JSON.stringify(await verify());
    for (const secret of [TOKEN, origin, ACCOUNT])
      expect(result).not.toContain(secret);
  });
});

// covers: AC-10
describe("makeRevoker", () => {
  const setup = () => {
    const delays: number[] = [];
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const revoker = makeRevoker(config, {
      timeoutMs: 2000,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    return { revoker, delays, error };
  };

  const logged = (error: ReturnType<typeof vi.spyOn>) =>
    JSON.stringify(error.mock.calls);

  it("is done after one try on success", async () => {
    const { revoker, delays } = setup();
    expect(await revoker(EMAIL)).toBe("done");
    expect(seen).toHaveLength(1);
    expect(delays).toEqual([]);
  });

  it("retries an unavailable reply after 2 and 5 seconds, then trips the breaker", async () => {
    script = [{ status: 503 }];
    const { revoker, delays, error } = setup();
    expect(await revoker(EMAIL)).toBe("failed");
    expect(seen).toHaveLength(3);
    expect(delays).toEqual([2000, 5000]);
    // The next learner in this run makes no request.
    expect(await revoker("other@example.test")).toBe("failed");
    expect(seen).toHaveLength(3);
    expect(error).toHaveBeenCalledOnce();
    for (const secret of [EMAIL, TOKEN, origin, "revoke_user"])
      expect(logged(error)).not.toContain(secret);
  });

  it("recovers when a retry succeeds", async () => {
    script = [{ status: 429 }, { status: 200, body: '{"success":true}' }];
    const { revoker, delays } = setup();
    expect(await revoker(EMAIL)).toBe("done");
    expect(delays).toEqual([2000]);
  });

  it("retries a try that timed out", async () => {
    script = ["hang", { status: 200, body: '{"success":true}' }];
    const delays: number[] = [];
    const revoker = makeRevoker(config, {
      timeoutMs: 50,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    expect(await revoker(EMAIL)).toBe("done");
    expect(seen).toHaveLength(2);
    expect(delays).toEqual([2000]);
  });

  it("fails a 2xx without success: true for that learner only, with no retry", async () => {
    script = [
      { status: 200, body: '{"success":false}' },
      { status: 200, body: '{"success":true}' },
    ];
    const { revoker, delays, error } = setup();
    expect(await revoker(EMAIL)).toBe("failed");
    expect(delays).toEqual([]);
    expect(await revoker("other@example.test")).toBe("done");
    expect(seen).toHaveLength(2);
    expect(error).not.toHaveBeenCalled();
  });

  it("trips the breaker on a 403 with no retry", async () => {
    script = [{ status: 403 }];
    const { revoker, delays, error } = setup();
    expect(await revoker(EMAIL)).toBe("failed");
    expect(delays).toEqual([]);
    expect(await revoker("other@example.test")).toBe("failed");
    expect(seen).toHaveLength(1);
    for (const secret of [EMAIL, TOKEN, origin])
      expect(logged(error)).not.toContain(secret);
  });

  it("fails a 400 for that learner only", async () => {
    script = [{ status: 400 }, { status: 200, body: '{"success":true}' }];
    const { revoker, delays } = setup();
    expect(await revoker(EMAIL)).toBe("failed");
    expect(delays).toEqual([]);
    expect(await revoker("other@example.test")).toBe("done");
    expect(seen).toHaveLength(2);
  });

  it("fails a learner with no email without a request or a trip", async () => {
    const { revoker } = setup();
    expect(await revoker(null)).toBe("failed");
    expect(seen).toHaveLength(0);
    expect(await revoker(EMAIL)).toBe("done");
  });

  it("keeps the breaker inside one revoker", async () => {
    script = [{ status: 401 }, { status: 200, body: '{"success":true}' }];
    const first = setup();
    expect(await first.revoker(EMAIL)).toBe("failed");
    const next = setup(); // the next reconciler run
    expect(await next.revoker(EMAIL)).toBe("done");
  });
});
