import { describe, expect, it, vi } from "vitest";

// Discovery fails at init: nothing listens on port 9. Every other value is a
// stub, so the test needs no database or Authentik and runs in CI too.
vi.stubEnv("APP_URL", "http://app.test");
vi.stubEnv("AUTHENTIK_URL", "http://127.0.0.1:9");
vi.stubEnv("AUTHENTIK_CLIENT_ID", "client");
vi.stubEnv("AUTHENTIK_CLIENT_SECRET", "secret");
vi.stubEnv("AUTHENTIK_CLIENT_SECRET_FILE", "");
vi.stubEnv("AUTH_SECRET", "a".repeat(32));
vi.stubEnv("AUTH_SECRET_FILE", "");
vi.stubEnv("DATABASE_HOST", "db.test");
vi.stubEnv("DATABASE_PASSWORD", "pw");
vi.stubEnv("DATABASE_PASSWORD_FILE", "");

const { auth } = await import("./index");

describe("auth() when Authentik discovery fails at init", () => {
  it("does not keep an instance without the authentik provider", async () => {
    const first = auth();
    const ctx = await first.$context;
    expect(ctx.socialProviders.map((p) => p.id)).not.toContain("authentik");
    await vi.waitFor(() => expect(auth()).not.toBe(first));
  });
});
