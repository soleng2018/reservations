import { describe, expect, it } from "vitest";
import { emailErrorLine } from "./email-log";

// covers: spec 0013 AC-21
describe("emailErrorLine (spec 0013 AC-21)", () => {
  it("shows the reason for failed, suppressed, and queued emails", () => {
    expect(emailErrorLine("failed", "x")).toBe("x");
    expect(emailErrorLine("suppressed", "y")).toBe("y");
    expect(emailErrorLine("queued", "z")).toBe("z");
    expect(emailErrorLine("queued", null)).toBeNull();
  });
  it("never shows one under a sent email", () => {
    expect(emailErrorLine("sent", "old retry note")).toBeNull();
  });
});
