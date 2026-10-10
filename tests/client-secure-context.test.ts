import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Dev runs on plain http at the LAN IP (the Authentik proxy refuses
// localhost), which is not a secure context, so browsers leave out
// `crypto.randomUUID` and `crypto.subtle` there. Client code that calls them
// breaks in dev only (the Add client button on /admin did).
const SECURE_ONLY = /\bcrypto\.(randomUUID|subtle)\b/;

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

describe("client code works on a plain http origin", () => {
  const client = ["app", "components", "lib"]
    .flatMap((d) => files(path.join(root, d)))
    .filter((f) => /^\s*["']use client["']/.test(readFileSync(f, "utf8")))
    .map((f) => path.relative(root, f));

  it("finds the client files it checks", () => {
    expect(client.length).toBeGreaterThan(0);
  });

  it.each(client)("%s avoids secure context only crypto", (file) => {
    expect(readFileSync(path.join(root, file), "utf8")).not.toMatch(
      SECURE_ONLY,
    );
  });
});
