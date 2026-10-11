import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

// Spec 0006 AC-9: `npm run secrets:keygen` prints a new keyring entry and
// writes nothing. Runs the real script, the way the npm script does, from an
// empty working directory so any file it wrote would show up there.

const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const cwd = mkdtempSync(path.join(tmpdir(), "keygen-"));

const keygen = () =>
  run(
    path.join(root, "node_modules/.bin/tsx"),
    [
      "--conditions=react-server",
      "--tsconfig",
      path.join(root, "tsconfig.json"),
      path.join(root, "scripts/secrets-keygen.ts"),
    ],
    { cwd },
  );

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(() => rmSync(cwd, { recursive: true, force: true }));

describe("secrets:keygen (AC-9)", () => {
  it("prints one dated key id with a 32 byte key, and its active id line", async () => {
    const { stdout, stderr } = await keygen();
    const entries = Object.entries(
      JSON.parse(stdout) as Record<string, string>,
    );
    expect(entries).toHaveLength(1);
    const [[keyId, key]] = entries;
    expect(keyId).toMatch(/^k\d{8}[0-9a-f]{4}$/);
    expect(Buffer.from(key, "base64")).toHaveLength(32);
    expect(stderr).toContain(`APP_ENCRYPTION_ACTIVE_KEY_ID=${keyId}`);
  }, 30_000);

  it("writes no file", async () => {
    await keygen();
    expect(readdirSync(cwd)).toEqual([]);
  }, 30_000);

  it("makes a new key on every run", async () => {
    const [a, b] = await Promise.all([keygen(), keygen()]);
    expect(a.stdout).not.toBe(b.stdout);
  }, 30_000);

  it("prints a keyring the app accepts as is", async () => {
    const { stdout, stderr } = await keygen();
    const keyId = /APP_ENCRYPTION_ACTIVE_KEY_ID=(\S+)/.exec(stderr)?.[1];
    vi.stubEnv("APP_ENCRYPTION_KEYS_FILE", "");
    vi.stubEnv("APP_ENCRYPTION_KEYS", stdout);
    vi.stubEnv("APP_ENCRYPTION_ACTIVE_KEY_ID", keyId);
    vi.resetModules();
    const { assertEncryptionEnv } = await import("@/server/env");
    const result = assertEncryptionEnv();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.keyring.activeKeyId).toBe(keyId);
  }, 30_000);
});
