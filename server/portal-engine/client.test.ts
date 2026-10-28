import { describe, expect, it } from "vitest";
import { makePortalClient, type Session } from "./client";
import { secret } from "./secret";
import { GuardStop } from "./stop";

const session: Session = {
  origin: "https://u1.nile-global.cloud",
  headers: secret({ "x-id-token": "tok-123", "x-nile-client": "c" }),
  close: async () => undefined,
};

type Seen = { url: string; init: RequestInit | undefined };

const clientWith = (respond: (url: string) => Response | Promise<Response>) => {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
    seen.push({ url: String(input), init });
    return respond(String(input));
  }) as typeof fetch;
  return { seen, client: makePortalClient(session, fetchImpl) };
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status });

// covers: AC-21, AC-25
describe("makePortalClient", () => {
  it("sends the headers, manual redirect, and a timeout; returns parsed json", async () => {
    const { client, seen } = clientWith(() => json(200, { a: 1 }));
    const got = await client.call({
      method: "PUT",
      path: "/api/v1/x/1?size=2",
      body: { b: 2 },
    });
    expect(got).toEqual({ ok: true, value: { status: 200, body: { a: 1 } } });
    const init = seen[0]?.init;
    expect(seen[0]?.url).toBe("https://u1.nile-global.cloud/api/v1/x/1?size=2");
    expect(init?.redirect).toBe("manual");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.body).toBe('{"b":2}');
    expect(init?.headers).toMatchObject({ "x-id-token": "tok-123" });
  });

  it("refuses a denied path, another origin, and a path outside /api/ before sending", async () => {
    const { client, seen } = clientWith(() => json(200, {}));
    for (const path of [
      "/api/v1/users/x",
      "//evil.example/api/v1/x",
      "/login",
      "https://evil.example/api/v1/x",
    ]) {
      await expect(client.call({ method: "GET", path })).rejects.toBeInstanceOf(
        GuardStop,
      );
    }
    expect(seen).toHaveLength(0);
  });

  it("treats a redirect as a redirect and never follows it", async () => {
    const { client, seen } = clientWith(
      () =>
        new Response(null, { status: 302, headers: { location: "/login" } }),
    );
    expect(await client.call({ method: "GET", path: "/api/v1/x" })).toEqual({
      ok: false,
      error: "redirect",
    });
    expect(seen).toHaveLength(1);
  });

  it("gives oversize for a reply over 5 MB, declared or streamed", async () => {
    const big = "x".repeat(5 * 1024 * 1024 + 1);
    const { client } = clientWith(() => new Response(big, { status: 200 }));
    expect(await client.call({ method: "GET", path: "/api/v1/x" })).toEqual({
      ok: false,
      error: "oversize",
    });
    const declared = clientWith(
      () =>
        new Response("{}", {
          status: 200,
          headers: { "content-length": String(6 * 1024 * 1024) },
        }),
    );
    expect(
      await declared.client.call({ method: "GET", path: "/api/v1/x" }),
    ).toEqual({ ok: false, error: "oversize" });
  });

  it("maps a timeout and a network failure, and drops a body that is not json", async () => {
    const timeout = clientWith(() => {
      throw new DOMException("t", "TimeoutError");
    });
    expect(
      await timeout.client.call({ method: "GET", path: "/api/v1/x" }),
    ).toEqual({
      ok: false,
      error: "timeout",
    });
    const down = clientWith(() => {
      throw new TypeError("fetch failed");
    });
    expect(
      await down.client.call({ method: "GET", path: "/api/v1/x" }),
    ).toEqual({
      ok: false,
      error: "network",
    });
    const html = clientWith(
      () => new Response("<html>login</html>", { status: 401 }),
    );
    expect(
      await html.client.call({ method: "GET", path: "/api/v1/x" }),
    ).toEqual({
      ok: true,
      value: { status: 401, body: undefined },
    });
  });
});
