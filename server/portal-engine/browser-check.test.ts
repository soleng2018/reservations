import { describe, expect, it } from "vitest";
import { checkBrowser } from "./browser-check";

describe("checkBrowser (AC-40)", () => {
  it("launches and closes the browser once", async () => {
    const calls: string[] = [];
    const r = await checkBrowser(async () => {
      calls.push("launch");
      return { close: async () => void calls.push("close") };
    });
    expect(r.ok).toBe(true);
    expect(calls).toEqual(["launch", "close"]);
  });

  it("fails with the first line of the launch error, and nothing else", async () => {
    const r = await checkBrowser(async () => {
      throw new Error("Failed to launch\nsecond line with detail");
    });
    expect(r).toEqual({ ok: false, error: "Failed to launch" });
  });
});
