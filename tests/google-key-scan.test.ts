import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Spec 0013 AC-5 and key invariants: the web process never decrypts the
// GOOGLE key. In app code, googleMailConfig (its only reader) is called by
// the worker alone, and decryptSecret lives in the API keys module, plus the
// Google sign in cookie (AC-27, amended 2026-10-16), which decrypts only its
// own short lived cookie, never a stored secret. Tests and generated types
// are not app code.
const DIRS = ["app", "components", "lib", "server", "worker", "scripts"];
const root = path.resolve(__dirname, "..");
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory()
      ? files(full)
      : /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)
        ? [full]
        : [];
  });

const scanned = DIRS.flatMap((d) => {
  try {
    return files(path.join(root, d));
  } catch {
    return [];
  }
})
  .map((f) => path.relative(root, f))
  .filter((f) => f !== "server/db/types.ts" && !f.endsWith("/testing.ts"));

const naming = (word: string) =>
  scanned.filter((f) =>
    readFileSync(path.join(root, f), "utf8").includes(word),
  );

describe("GOOGLE key source scan (spec 0013 AC-5)", () => {
  it("reads the key only in the worker", () => {
    expect(naming("googleMailConfig").sort()).toEqual([
      "server/catalog/api-keys.ts",
      "worker/index.ts",
    ]);
  });

  it("decrypts only in the API keys module and the sign in cookie (and the crypto module itself)", () => {
    expect(naming("decryptSecret").sort()).toEqual([
      "server/catalog/api-keys.ts",
      "server/crypto/secrets.ts",
      "server/google/sign-in-cookie.ts",
    ]);
  });

  it("names the sign in cookie only in its own module", () => {
    expect(naming("hol_google_sign_in")).toEqual([
      "server/google/sign-in-cookie.ts",
    ]);
  });
});
