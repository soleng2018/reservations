import { describe, expect, it } from "vitest";
import { withTimeoutAndRetry } from "./client";

// A fetch that never answers until it is aborted.
const hanging = (calls: { n: number }) => (_: unknown, init?: RequestInit) =>
  new Promise<Response>((_, reject) => {
    calls.n += 1;
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
  });

describe("withTimeoutAndRetry (AC-15)", () => {
  it("gives up on a hanging read within one timeout, retries included", async () => {
    const calls = { n: 0 };
    const fetchApi = withTimeoutAndRetry(hanging(calls), 50);
    const started = Date.now();
    await expect(fetchApi("https://x.test/api")).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(120);
  });

  it("retries a read after a 5xx while time remains", async () => {
    const statuses = [503, 200];
    const fetchApi = withTimeoutAndRetry(
      async () => new Response(null, { status: statuses.shift() }),
      1_000,
    );
    expect((await fetchApi("https://x.test/api")).status).toBe(200);
  });

  it("never retries a write", async () => {
    let calls = 0;
    const fetchApi = withTimeoutAndRetry(async () => {
      calls += 1;
      return new Response(null, { status: 503 });
    }, 1_000);
    const res = await fetchApi("https://x.test/api", { method: "POST" });
    expect(res.status).toBe(503);
    expect(calls).toBe(1);
  });
});

describe("withTimeoutAndRetry retry rules (AC-15)", () => {
  const counting = (responses: ReadonlyArray<() => Promise<Response>>) => {
    const calls = { n: 0 };
    const base = () => {
      const next = responses[Math.min(calls.n, responses.length - 1)];
      calls.n += 1;
      return next();
    };
    return { calls, base };
  };
  const status = (s: number) => () =>
    Promise.resolve(new Response(null, { status: s }));
  const networkError = () => Promise.reject(new TypeError("fetch failed"));

  it("retries a read after a network error", async () => {
    const { calls, base } = counting([networkError, status(200)]);
    const res = await withTimeoutAndRetry(base, 1_000)("https://x.test/api");
    expect(res.status).toBe(200);
    expect(calls.n).toBe(2);
  });

  it("stops after three read attempts and returns the last 5xx", async () => {
    const { calls, base } = counting([status(502)]);
    const res = await withTimeoutAndRetry(base, 1_000)("https://x.test/api");
    expect(res.status).toBe(502);
    expect(calls.n).toBe(3);
  });

  it("rethrows the network error once read attempts run out", async () => {
    const { calls, base } = counting([networkError]);
    await expect(
      withTimeoutAndRetry(base, 1_000)("https://x.test/api"),
    ).rejects.toThrow("fetch failed");
    expect(calls.n).toBe(3);
  });

  it("does not retry a 4xx read", async () => {
    const { calls, base } = counting([status(404)]);
    const res = await withTimeoutAndRetry(base, 1_000)("https://x.test/api");
    expect(res.status).toBe(404);
    expect(calls.n).toBe(1);
  });

  it("never resends a write after a network error", async () => {
    const { calls, base } = counting([networkError, status(201)]);
    await expect(
      withTimeoutAndRetry(base, 1_000)("https://x.test/api", {
        method: "PATCH",
      }),
    ).rejects.toThrow("fetch failed");
    expect(calls.n).toBe(1);
  });

  it("treats a lowercase get as a read", async () => {
    const { calls, base } = counting([status(503), status(200)]);
    const res = await withTimeoutAndRetry(base, 1_000)("https://x.test/api", {
      method: "get",
    });
    expect(res.status).toBe(200);
    expect(calls.n).toBe(2);
  });
});
