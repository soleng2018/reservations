import { afterEach, describe, expect, it, vi } from "vitest";
import sitemap, { dynamic } from "./sitemap";

// Spec 0009: the sitemap lists the one indexable page, /, on APP_URL.
describe("sitemap", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // covers: AC-8
  it("lists exactly one URL, the landing", () => {
    vi.stubEnv("APP_URL", "https://hol.example.com");
    expect(sitemap()).toEqual([{ url: "https://hol.example.com/" }]);
  });

  // covers: AC-8, origin only, no doubled slash
  it.each([
    ["a trailing slash", "https://hol.example.com/"],
    ["a path", "https://hol.example.com/some/path"],
  ])("uses the APP_URL origin when it has %s", (_, value) => {
    vi.stubEnv("APP_URL", value);
    expect(sitemap()).toEqual([{ url: "https://hol.example.com/" }]);
  });

  // covers: AC-9, nothing public names the admin entry
  it("never names the admin entry path", () => {
    vi.stubEnv("APP_URL", "https://hol.example.com");
    vi.stubEnv("ADMIN_ENTRY_PATH", "/s3cr3t-entry");
    const text = JSON.stringify(sitemap());
    expect(text).not.toContain("/s3cr3t-entry");
    expect(text).not.toContain("/auth/admin-entry");
  });

  // covers: AC-9, so `next build` never reads APP_URL
  it("renders per request", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  it("throws when APP_URL is missing", () => {
    vi.stubEnv("APP_URL", undefined);
    expect(() => sitemap()).toThrow();
  });
});
