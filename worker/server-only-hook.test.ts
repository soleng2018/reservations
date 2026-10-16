import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Spec 0013 AC-22: run a real Node process with the hook, as `npm run
// worker` does, and ask it how two specifiers resolve.
const HOOK = fileURLToPath(new URL("./server-only-hook.mjs", import.meta.url));

const resolveWith = (args: readonly string[], specifier: string) =>
  execFileSync(
    process.execPath,
    [
      ...args,
      "--input-type=module",
      "-e",
      `await import(${JSON.stringify(specifier)}); console.log(import.meta.resolve(${JSON.stringify(specifier)}))`,
    ],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trim();

describe("worker server-only hook", () => {
  it("maps server-only to the package's empty.js", () => {
    expect(resolveWith(["--import", HOOK], "server-only")).toMatch(
      /\/node_modules\/server-only\/empty\.js$/,
    );
  });

  it("fails to load server-only without the hook", () => {
    expect(() => resolveWith([], "server-only")).toThrow();
  });

  it("leaves every other specifier alone (no react-server condition)", () => {
    expect(resolveWith(["--import", HOOK], "react")).toMatch(
      /\/node_modules\/react\/index\.js$/,
    );
  });
});
