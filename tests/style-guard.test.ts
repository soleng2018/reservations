import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Spec 0005 key invariants: outside components/ui (shadcn's own code),
// colors come from the Nile tokens only, and there is no dark mode.
const RULES: readonly (readonly [string, RegExp])[] = [
  ["raw hex color", /#[0-9a-f]{3,8}\b/i],
  ["rgb() color", /\brgba?\(/],
  ["arbitrary color class", /\b(?:bg|text|border|ring|fill|stroke)-\[#/],
  ["dark: class", /\bdark:/],
  [
    "raw palette class",
    /\b(?:text|bg|border|ring)-(?:black|white|zinc|gray|slate|neutral|stone)\b/,
  ],
];

const root = path.resolve(__dirname, "..");
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory())
      return full === path.join(root, "components", "ui") ? [] : files(full);
    return /\.tsx?$/.test(name) ? [full] : [];
  });

const hits = (file: string): readonly string[] =>
  readFileSync(file, "utf8")
    .split("\n")
    .flatMap((line, i) =>
      RULES.filter(([, re]) => re.test(line)).map(
        ([rule]) => `${i + 1}: ${rule}: ${line.trim()}`,
      ),
    );

describe("style guard", () => {
  const scanned = ["app", "components"]
    .flatMap((d) => files(path.join(root, d)))
    .map((f) => path.relative(root, f));

  it("finds the files it checks", () => {
    expect(scanned.length).toBeGreaterThan(0);
  });

  it.each(scanned)("%s uses tokens only", (file) => {
    expect(hits(path.join(root, file))).toEqual([]);
  });
});
