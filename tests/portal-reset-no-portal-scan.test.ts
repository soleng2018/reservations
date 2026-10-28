import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Spec 0022 AC-14: the page and the configuration side never contact a Nile
// Portal and handle no portal password or token. The engine lives in
// server/portal-engine/ (spec 0023); nothing here may reach it.
const root = path.resolve(__dirname, "..");
const AREAS = [
  "app/admin/nile-portal-reset",
  "server/portal-reset",
  "lib/portal-reset",
  "components/admin",
];

const sources = (dir: string): string[] => {
  try {
    return readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      return statSync(full).isDirectory()
        ? sources(full)
        : /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)
          ? [full]
          : [];
    });
  } catch {
    return [];
  }
};

const files = AREAS.flatMap((area) => sources(path.join(root, area))).filter(
  (f) =>
    !f.includes(`${path.sep}components${path.sep}admin${path.sep}`) ||
    path.basename(f).startsWith("portal-reset-"),
);

const HTTP_IMPORT =
  /from\s+["'](?:node:)?(?:https?|http2|net|tls|undici|axios|got|node-fetch|ky|superagent|ws)["']/;

describe("AC-14: the reset page and its configuration never contact a portal", () => {
  it("scans the files it should", () => {
    expect(files.length).toBeGreaterThan(10);
    expect(files.some((f) => f.endsWith("server/portal-reset/steps.ts"))).toBe(
      true,
    );
  });

  it.each(files.map((f) => [path.relative(root, f), readFileSync(f, "utf8")]))(
    "%s",
    (_file, text) => {
      expect(text).not.toMatch(/\bfetch\s*\(/);
      expect(text).not.toMatch(HTTP_IMPORT);
      expect(text).not.toMatch(/portal-engine/);
      expect(text).not.toMatch(/x-id-token/i);
    },
  );
});
