import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import robots, { dynamic } from "./robots";

// Spec 0009: robots.txt opens / to crawlers, closes the admin and API paths,
// and points at the sitemap, all from APP_URL read per request.
describe("robots", () => {
  beforeEach(() => {
    vi.stubEnv("APP_URL", "https://hol.example.com/some/path");
    vi.stubEnv("ADMIN_ENTRY_PATH", "/s3cr3t-entry");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // covers: AC-8
  it("allows / and disallows /admin and /api/ for every crawler", () => {
    expect(robots().rules).toEqual({
      userAgent: "*",
      allow: "/",
      disallow: ["/admin", "/api/"],
    });
  });

  // covers: AC-8, sitemap URL is the APP_URL origin, path dropped
  it("points at the sitemap on the APP_URL origin", () => {
    expect(robots().sitemap).toBe("https://hol.example.com/sitemap.xml");
  });

  // covers: AC-9, nothing public names the admin entry
  it("never names the admin entry path", () => {
    const text = JSON.stringify(robots());
    expect(text).not.toContain("/s3cr3t-entry");
    expect(text).not.toContain("/auth/admin-entry");
  });

  // covers: AC-9
  it("works without the auth secrets", () => {
    vi.stubEnv("AUTH_SECRET", undefined);
    vi.stubEnv("AUTHENTIK_CLIENT_SECRET", undefined);
    expect(robots().sitemap).toBe("https://hol.example.com/sitemap.xml");
  });

  // covers: AC-9, so `next build` never reads APP_URL
  it("renders per request", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  it("throws when APP_URL is missing", () => {
    vi.stubEnv("APP_URL", undefined);
    expect(() => robots()).toThrow();
  });
});
