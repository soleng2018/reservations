import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Spec 0023 AC-34: what is data and what is code. The engine names no kind of
// portal object. The pages to visit, the routes to skip, and the flags that
// mark a system item are data (`discovery.json`, the steps, `guards.json`,
// `deny-list.json`). Comments may name them; code may not.
const FORBIDDEN = [
  "ssid",
  "segment",
  "radius",
  "dhcp",
  "siem",
  "webhook",
  "portalconfig",
  "idps",
  "users",
  "popTunnelUsed",
  "cloudDHCP",
  "isDefault",
];

const root = path.resolve(__dirname, "..");
const dir = path.join(root, "server/portal-engine");
const sources = readdirSync(dir)
  .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
  // The in memory fake portal is test support: it must name what it fakes.
  .filter((f) => f !== "testing.ts");

// Code without comments: block comments and whole line or trailing `//`
// comments removed. Strings stay, because a string is code.
const withoutComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

describe("engine names no portal object type (AC-34)", () => {
  it("finds the engine files it checks", () => {
    expect(sources).toContain("interpret.ts");
    expect(sources).toContain("discovery.ts");
    expect(sources).not.toContain("testing.ts");
  });

  it("holds none of the forbidden words outside comments", () => {
    const found = sources.flatMap((file) => {
      const code = withoutComments(
        readFileSync(path.join(dir, file), "utf8"),
      ).toLowerCase();
      return FORBIDDEN.filter((word) => code.includes(word.toLowerCase())).map(
        (word) => `${file}: ${word}`,
      );
    });
    expect(found).toEqual([]);
  });

  it("catches a forbidden word in code and ignores one in a comment", () => {
    expect(withoutComments('const x = "/api/ssids";')).toContain("ssids");
    expect(withoutComments("// the ssids\nconst x = 1;")).not.toContain("ssid");
    expect(withoutComments("/* ssid */ const x = 1;")).not.toContain("ssid");
  });
});
