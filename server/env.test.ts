import { afterEach, describe, expect, it, vi } from "vitest";
import { isProduction } from "./env";

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
