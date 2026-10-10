import { afterEach, describe, expect, it, vi } from "vitest";
import { isProduction } from "./env";

describe("isProduction", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is true in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(isProduction()).toBe(true);
  });

  it("is false in development and test", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(isProduction()).toBe(false);
    vi.stubEnv("NODE_ENV", "test");
    expect(isProduction()).toBe(false);
  });

  it("is false when the value is missing or unknown", () => {
    vi.stubEnv("NODE_ENV", undefined);
    expect(isProduction()).toBe(false);
    vi.stubEnv("NODE_ENV", "staging");
    expect(isProduction()).toBe(false);
  });
});
