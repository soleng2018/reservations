import { inspect } from "node:util";
import { describe, expect, it } from "vitest";

import { secret } from "./secret";

// covers: AC-30
describe("secret", () => {
  const s = secret("hunter2-hunter2");
  it("reveals only through reveal", () => {
    expect(s.reveal()).toBe("hunter2-hunter2");
  });
  it("prints as redacted everywhere", () => {
    expect(String(s)).toBe("[redacted]");
    expect(`${s}`).toBe("[redacted]");
    expect(JSON.stringify({ s })).toBe('{"s":"[redacted]"}');
    expect(inspect(s)).toContain("[redacted]");
    expect(inspect(s)).not.toContain("hunter2");
    expect(JSON.stringify(Object.entries(s))).not.toContain("hunter2");
  });
});
