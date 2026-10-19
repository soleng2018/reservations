import { describe, expect, it } from "vitest";
import { dynamic, metadata } from "./page";

// covers: spec 0014 AC-9 (the page's own exports; its views are in
// e2e/set-password.spec.ts and e2e/set-password-public.spec.ts).
describe("/set-password/[token] page exports (spec 0014 AC-9)", () => {
  it("renders on every request, so the DB clock decides each view", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  it("sends the origin only as Referer, so the token never leaves in it", () => {
    // Not no-referrer, which nulls Origin on a native form POST.
    expect(metadata.referrer).toBe("strict-origin");
  });

  it("keeps the root's noindex by not setting robots of its own", () => {
    expect(metadata.robots).toBeUndefined();
  });
});
