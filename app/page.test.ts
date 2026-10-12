import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dynamic, generateMetadata } from "./page";

const TITLE = "Nile Hands-On Labs";
const DESCRIPTION =
  "Reserve a remote Nile testbed with switches, access points, and wireless clients, and start testing in minutes.";
const IMAGE = {
  url: "/brand/hol-social.jpg",
  width: 1200,
  height: 630,
  alt: TITLE,
};

// Spec 0009: the landing's metadata. The rendered head is pinned end to end
// in e2e/landing.spec.ts; this pins the values Next is handed, in CI.
describe("landing generateMetadata", () => {
  beforeEach(() => {
    vi.stubEnv("APP_URL", "https://hol.example.com/some/path");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // covers: AC-6, metadataBase is the APP_URL origin, path dropped
  it("bases every relative URL on the APP_URL origin", () => {
    expect(String(generateMetadata().metadataBase)).toBe(
      "https://hol.example.com/",
    );
  });

  // covers: AC-6, title not suffixed by the root template
  it("uses the absolute title and the Copy description", () => {
    const meta = generateMetadata();
    expect(meta.title).toEqual({ absolute: TITLE });
    expect(meta.description).toBe(DESCRIPTION);
  });

  // covers: AC-6, AC-7, the one page that opts in to search
  it("opts in to indexing with / as its canonical", () => {
    const meta = generateMetadata();
    expect(meta.robots).toEqual({ index: true, follow: true });
    expect(meta.alternates).toEqual({ canonical: "/" });
  });

  // covers: AC-6
  it("sends the Open Graph card", () => {
    expect(generateMetadata().openGraph).toEqual({
      type: "website",
      siteName: TITLE,
      title: TITLE,
      description: DESCRIPTION,
      url: "/",
      images: [IMAGE],
    });
  });

  // covers: AC-6
  it("sends the large Twitter card", () => {
    expect(generateMetadata().twitter).toEqual({
      card: "summary_large_image",
      title: TITLE,
      description: DESCRIPTION,
      images: [IMAGE],
    });
  });

  // covers: AC-9, nothing public names the admin entry
  it("never names the admin entry path", () => {
    vi.stubEnv("ADMIN_ENTRY_PATH", "/s3cr3t-entry");
    const text = JSON.stringify(generateMetadata());
    expect(text).not.toContain("/s3cr3t-entry");
    expect(text).not.toContain("/auth/admin-entry");
  });

  // covers: AC-9, works without the auth secrets
  it("needs only APP_URL", () => {
    vi.stubEnv("AUTH_SECRET", undefined);
    vi.stubEnv("AUTHENTIK_CLIENT_SECRET", undefined);
    expect(String(generateMetadata().metadataBase)).toBe(
      "https://hol.example.com/",
    );
  });

  // covers: AC-9, so `next build` never reads APP_URL
  it("renders per request", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  it("throws when APP_URL is missing", () => {
    vi.stubEnv("APP_URL", undefined);
    expect(() => generateMetadata()).toThrow();
  });
});
