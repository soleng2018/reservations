import { afterEach, describe, expect, it, vi } from "vitest";
import { appUrl, cloudflareEnv, isProduction, workerEnv } from "./env";

describe("isProduction", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is true in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(isProduction()).toBe(true);
  });

  it("is false in development and test", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(isProduction()).toBe(false);
    vi.stubEnv("NODE_ENV", "test");
    expect(isProduction()).toBe(false);
  });

  it("is false when the value is missing or unknown", () => {
    vi.stubEnv("NODE_ENV", undefined);
    expect(isProduction()).toBe(false);
    vi.stubEnv("NODE_ENV", "staging");
    expect(isProduction()).toBe(false);
  });
});

describe("encryptionEnv", () => {
  // A fresh module per test: a valid keyring is cached on first use.
  const load = async () => {
    vi.resetModules();
    return import("./env");
  };
  const key = (n = 32) => Buffer.alloc(n, 7).toString("base64");
  const keys = (obj: unknown) => JSON.stringify(obj);
  const setEnv = (keyring: string | undefined, active: string | undefined) => {
    vi.stubEnv("APP_ENCRYPTION_KEYS_FILE", "");
    vi.stubEnv("APP_ENCRYPTION_KEYS", keyring);
    vi.stubEnv("APP_ENCRYPTION_ACTIVE_KEY_ID", active);
  };

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("parses a valid keyring with its active key", async () => {
    setEnv(keys({ k1: key(), k2: key() }), "k2");
    const { keyring } = (await load()).encryptionEnv();
    expect(keyring.activeKeyId).toBe("k2");
    expect([...keyring.keys.keys()]).toEqual(["k1", "k2"]);
    expect(keyring.keys.get("k2")).toHaveLength(32);
  });

  it("reads the keyring from APP_ENCRYPTION_KEYS_FILE", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const file = path.join(mkdtempSync(path.join(tmpdir(), "keyring-")), "k");
    writeFileSync(file, `${keys({ k1: key() })}\n`);
    setEnv(undefined, "k1");
    vi.stubEnv("APP_ENCRYPTION_KEYS_FILE", file);
    expect((await load()).encryptionEnv().keyring.activeKeyId).toBe("k1");
  });

  it.each([
    ["missing", undefined, "k1", "APP_ENCRYPTION_KEYS is missing"],
    ["bad JSON", "{not json", "k1", "is not a JSON object"],
    ["a JSON array", "[]", "k1", "is not a JSON object"],
    ["a non string key", keys({ k1: 5 }), "k1", "must be a base64 string"],
    ["a bad key id", keys({ "bad-id": key() }), "bad-id", "must match"],
    ["a 31 byte key", keys({ k1: key(31) }), "k1", "exactly 32 bytes"],
    ["a 33 byte key", keys({ k1: key(33) }), "k1", "exactly 32 bytes"],
    ["an empty keyring", keys({}), "k1", "the keyring is empty"],
    [
      "no active id",
      keys({ k1: key() }),
      undefined,
      "ACTIVE_KEY_ID is missing",
    ],
    ["an unknown active id", keys({ k1: key() }), "k2", "not in the keyring"],
  ])("throws for %s, naming it", async (_, keyring, active, message) => {
    setEnv(keyring, active);
    const env = await load();
    expect(() => env.encryptionEnv()).toThrow(message);
  });

  it("never prints a key", async () => {
    const secret = Buffer.alloc(31, 9).toString("base64");
    setEnv(keys({ k1: secret }), "k2");
    const result = (await load()).assertEncryptionEnv();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).not.toContain(secret);
  });

  it("names an unreadable keyring file", async () => {
    setEnv(undefined, "k1");
    vi.stubEnv("APP_ENCRYPTION_KEYS_FILE", "/nonexistent/keyring.json");
    expect((await load()).assertEncryptionEnv()).toEqual({
      ok: false,
      error: "Encryption env: APP_ENCRYPTION_KEYS_FILE can't be read",
    });
  });

  it("parses the keygen output as a valid keyring", async () => {
    const { newKeyringEntry } = await import("./crypto/secrets");
    const entry = newKeyringEntry(new Date());
    setEnv(keys({ [entry.keyId]: entry.key }), entry.keyId);
    expect((await load()).assertEncryptionEnv().ok).toBe(true);
  });
});

// The public origin for the landing metadata, robots.txt, and the sitemap
// (spec 0009).
describe("appUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // covers: AC-6, AC-8, origin only, so joined paths never double a slash
  it.each([
    ["a bare origin", "https://hol.example.com", "https://hol.example.com"],
    ["a trailing slash", "https://hol.example.com/", "https://hol.example.com"],
    [
      "a path and query",
      "https://hol.example.com/some/path?x=1",
      "https://hol.example.com",
    ],
    ["a LAN dev URL", "http://10.1.255.18:3000", "http://10.1.255.18:3000"],
  ])("returns only the origin for %s", (_, value, origin) => {
    vi.stubEnv("APP_URL", value);
    expect(appUrl()).toBe(origin);
  });

  // covers: AC-9, public routes work without the auth secrets
  it("needs no auth secrets", () => {
    vi.stubEnv("APP_URL", "https://hol.example.com");
    vi.stubEnv("AUTH_SECRET", undefined);
    vi.stubEnv("AUTHENTIK_CLIENT_SECRET", undefined);
    vi.stubEnv("AUTHENTIK_CLIENT_ID", undefined);
    vi.stubEnv("AUTHENTIK_URL", undefined);
    expect(appUrl()).toBe("https://hol.example.com");
  });

  it("reads APP_URL on every call, not a cached first value", () => {
    vi.stubEnv("APP_URL", "https://one.example.com");
    expect(appUrl()).toBe("https://one.example.com");
    vi.stubEnv("APP_URL", "https://two.example.com");
    expect(appUrl()).toBe("https://two.example.com");
  });

  // covers: AC-9, a missing or bad APP_URL is the one failure the API allows
  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["not a URL", "hol.example.com"],
  ])("throws when APP_URL is %s", (_, value) => {
    vi.stubEnv("APP_URL", value);
    expect(() => appUrl()).toThrow();
  });
});

// covers: spec 0012 AC-11
describe("cloudflareEnv", () => {
  const ACCOUNT = "0123456789abcdef0123456789abcdef";
  const set = (account?: string, token?: string, file?: string) => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", account);
    vi.stubEnv("CLOUDFLARE_API_TOKEN", token);
    vi.stubEnv("CLOUDFLARE_API_TOKEN_FILE", file);
  };
  const tokenFile = async (content: string) => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const file = path.join(mkdtempSync(path.join(tmpdir(), "cf-")), "t");
    writeFileSync(file, content);
    return file;
  };

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is off when both are unset", () => {
    set();
    expect(cloudflareEnv()).toBeNull();
  });

  it("reads the token from the file", async () => {
    set(ACCOUNT, undefined, await tokenFile("cf-secret-token\n"));
    expect(cloudflareEnv()).toEqual({
      accountId: ACCOUNT,
      apiToken: "cf-secret-token",
    });
  });

  it("fails when only one is set, without printing the token", () => {
    set(ACCOUNT);
    expect(() => cloudflareEnv()).toThrow("set both");
    set(undefined, "cf-secret-token");
    expect(() => cloudflareEnv()).toThrow("set both");
    try {
      cloudflareEnv();
    } catch (e) {
      expect(String(e)).not.toContain("cf-secret-token");
    }
  });

  it("fails on an empty or unreadable token file", async () => {
    set(ACCOUNT, undefined, await tokenFile("  \n"));
    expect(() => cloudflareEnv()).toThrow("CLOUDFLARE_API_TOKEN_FILE is empty");
    set(ACCOUNT, undefined, "/nonexistent/cf-token");
    expect(() => cloudflareEnv()).toThrow("can't be read");
  });

  it("fails on an account id that is not one", () => {
    set("../../zones", "cf-secret-token");
    expect(() => cloudflareEnv()).toThrow("not a Cloudflare account id");
  });

  it("is checked by workerEnv at start", () => {
    vi.stubEnv("WORKER_ENABLED", undefined);
    set(ACCOUNT);
    expect(() => workerEnv()).toThrow("set both");
    set();
    expect(workerEnv()).toEqual({ WORKER_ENABLED: false, cloudflare: null });
  });
});
