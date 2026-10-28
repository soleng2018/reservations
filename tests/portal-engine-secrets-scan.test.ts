import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Spec 0023 AC-30, AC-42: the password, the three sign in headers, and a
// portal reply exist only in memory. This scan keeps the places that can leak
// them few: no `console` in the engine, `reveal()` only where a value is sent,
// nothing written to disk, and the automation module never prints.
const root = path.resolve(__dirname, "..");
const engine = path.join(root, "server/portal-engine");

const code = (file: string): string =>
  readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

const engineFiles = readdirSync(engine)
  .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
  .map((f) => ({ name: f, text: code(path.join(engine, f)) }));

// Where a `Secret` is opened: the client (the headers go into a request), the
// browser sign in (the password is typed into the sign in page), and the
// discovery collector (the signed in cookies seed a fresh browser context in
// memory). Nowhere else may call `.reveal(`.
const MAY_REVEAL = new Set(["client.ts", "sign-in.ts", "discovery.ts"]);

describe("portal engine secrets scan (AC-30, AC-42)", () => {
  it("finds the engine files it checks", () => {
    expect(engineFiles.map((f) => f.name)).toEqual(
      expect.arrayContaining(["client.ts", "sign-in.ts", "connect.ts"]),
    );
  });

  it("calls no console method in the engine", () => {
    const found = engineFiles
      .filter((f) => /\bconsole\s*\./.test(f.text))
      .map((f) => f.name);
    expect(found).toEqual([]);
  });

  it("opens a Secret only where the value is sent", () => {
    const found = engineFiles
      .filter((f) => /\.reveal\(/.test(f.text) && !MAY_REVEAL.has(f.name))
      .map((f) => f.name);
    expect(found).toEqual([]);
  });

  it("writes nothing to disk and keeps the browser state in memory", () => {
    const found = engineFiles
      .filter((f) =>
        /node:fs|writeFile|createWriteStream|storageState\(\s*\{[^}]*path|recordHar|tracing\.start|userDataDir/.test(
          f.text,
        ),
      )
      .map((f) => f.name);
    expect(found).toEqual([]);
  });

  it("never prints or audits the password in the automation account module", () => {
    const text = code(path.join(root, "server/authentik/portal-automation.ts"));
    expect(text).not.toMatch(/console\s*\./);
    expect(text).not.toMatch(/audit\(/);
    expect(text).not.toMatch(/\.reveal\(/);
  });

  it("catches a leak when one is written (the scan itself works)", () => {
    expect(/\bconsole\s*\./.test('console.log("x")')).toBe(true);
    expect(/\.reveal\(/.test("password.reveal()")).toBe(true);
  });
});
