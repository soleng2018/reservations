import { describe, expect, it } from "vitest";
import { portalMessage, redactMessage, redactedPortalMessage } from "./redact";

// covers: AC-30
describe("redactMessage", () => {
  it("replaces URLs, emails, tokens, and long runs", () => {
    const jwt = "eyJhbGciOi.eyJzdWIiOiIx.sig_nature";
    const out = redactMessage(
      `Hook https://hooks.example.com/x?t=abc to a@b.com failed ${jwt} key ABCDEFGHIJKLMNOPQRSTUVWXYZ012`,
    );
    expect(out).toBe("Hook [url] to [email] failed [token] key [token]");
  });
  it("cuts to 300 characters", () => {
    expect(redactMessage("word ".repeat(200)).length).toBe(300);
  });
});

describe("portalMessage", () => {
  it("takes only errors[].message and message, never other fields", () => {
    expect(
      portalMessage({
        errors: [{ message: "one", detail: "no" }, { message: "two" }],
        message: "top",
        token: "secret",
      }),
    ).toBe("one; two; top");
    expect(portalMessage("raw text")).toBe("");
    expect(redactedPortalMessage({ token: "x" })).toBe("");
  });
});
