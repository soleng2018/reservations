import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Spec 0019 AC-12: only the booking flows (the guest saga and the learner's
// reschedule) set a Nile login, and the function itself goes through
// guardUserWrite. A new caller fails this scan.
const ALLOWED_CALLERS = new Set([
  "server/booking/guest-booking.ts",
  "server/booking/manage.ts",
  "server/authentik/nile-login.ts",
]);
const DIRS = ["app", "lib", "server", "worker", "scripts"];

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

describe("Nile login source scan (spec 0019 AC-12)", () => {
  const scanned = DIRS.flatMap((d) => files(path.join(root, d))).map((f) =>
    path.relative(root, f),
  );
  const text = (f: string) => readFileSync(path.join(root, f), "utf8");

  it("is called only by the two booking flows", () => {
    const callers = scanned.filter((f) => text(f).includes("ensureNileLogin"));
    expect(callers.sort()).toEqual([...ALLOWED_CALLERS].sort());
  });

  it("writes the user only after guardUserWrite", () => {
    const source = text("server/authentik/nile-login.ts");
    expect(source).toContain('guardUserWrite(api, input.pk, "learner")');
    expect(source).toContain('guardUserWrite(api, pk, "learner")');
    expect(source).toContain('guardUserWrite(api, from.pk, "learner")');
    const writes = source.match(/coreUsersPartialUpdate/g) ?? [];
    const guards = source.match(/guardUserWrite\(/g) ?? [];
    expect(guards.length).toBeGreaterThanOrEqual(writes.length);
  });
});
