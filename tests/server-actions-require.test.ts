import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// AC-14: every exported Server Action calls requireAdmin() or
// requireLearner(), unless it is public by design and listed here.
const PUBLIC_ACTIONS = new Set(["app/auth/actions.ts#signInWithSso"]);

const root = path.resolve(__dirname, "..");
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory()
      ? files(full)
      : /\.tsx?$/.test(name) && !name.endsWith(".test.ts")
        ? [full]
        : [];
  });

// Exported async functions in a file that starts with "use server", with the
// body text up to the next export.
const actions = (file: string) => {
  const text = readFileSync(file, "utf8");
  if (!/^\s*["']use server["']/.test(text)) return [];
  const rel = path.relative(root, file);
  return [...text.matchAll(/export\s+async\s+function\s+(\w+)/g)].map((m) => {
    const start = m.index ?? 0;
    const next = text.indexOf("\nexport ", start + 1);
    return {
      id: `${rel}#${m[1]}`,
      body: text.slice(start, next === -1 ? undefined : next),
    };
  });
};

describe("Server Actions authorize first", () => {
  const all = ["app", "server", "components"]
    .map((d) => path.join(root, d))
    .filter((d) => {
      try {
        return statSync(d).isDirectory();
      } catch {
        return false;
      }
    })
    .flatMap(files)
    .flatMap(actions);

  it("finds the actions it checks", () => {
    expect(all.length).toBeGreaterThan(0);
  });

  it.each(all)("$id calls requireAdmin or requireLearner", ({ id, body }) => {
    if (PUBLIC_ACTIONS.has(id)) return;
    expect(body).toMatch(/await\s+require(Admin|Learner)\(\)/);
  });
});
