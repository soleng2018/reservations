import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Spec 0013 AC-33 (amended 2026-10-16): a Google sign in's refresh token
// lives only in the ciphertext and in memory in the worker or the saving
// action. In app code it is named only where it is exchanged and refreshed
// (server/google/oauth.ts), checked and handed on (server/google/verify.ts,
// which runs AC-28's steps 5 to 8), and encrypted or decrypted
// (server/catalog/api-keys.ts). Tests, test support, and generated types
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

describe("refresh token source scan (spec 0013 AC-33)", () => {
  it("names refreshToken only where it is exchanged, checked, and stored", () => {
    expect(naming("refreshToken").sort()).toEqual([
      "server/catalog/api-keys.ts",
      "server/google/oauth.ts",
      "server/google/verify.ts",
    ]);
  });
});
