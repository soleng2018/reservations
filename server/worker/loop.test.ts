import { describe, expect, it } from "vitest";
import { PURGE_EVERY_MS, purgeDue, runTick, withTimeout } from "./loop";

const quiet = { timeoutMs: 1_000, shouldStop: () => false, log: () => {} };

// covers: AC-11
describe("runTick (AC-11)", () => {
  it("runs every step in order, and a throwing step does not stop the rest", async () => {
    const ran: string[] = [];
    const step = (name: string, fail = false) => ({
      name,
      run: async () => {
        ran.push(name);
        if (fail) throw new Error("boom");
      },
    });
    const outcomes = await runTick(
      [step("a"), step("b", true), step("c")],
      quiet,
    );
    expect(ran).toEqual(["a", "b", "c"]);
    expect(outcomes).toEqual([
      { name: "a", ok: true },
      { name: "b", ok: false, error: "boom" },
      { name: "c", ok: true },
    ]);
  });

  it("times a hanging step out and moves on", async () => {
    const outcomes = await runTick(
      [
        { name: "hang", run: () => new Promise(() => {}) },
        { name: "next", run: async () => {} },
      ],
      { ...quiet, timeoutMs: 20 },
    );
    expect(outcomes).toEqual([
      { name: "hang", ok: false, error: "timed out after 20 ms" },
      { name: "next", ok: true },
    ]);
  });

  it("finishes the current step and skips the rest after a stop", async () => {
    const stopped = { now: false };
    const outcomes = await runTick(
      [
        { name: "current", run: async () => (stopped.now = true) },
        { name: "skipped", run: async () => {} },
      ],
      { ...quiet, shouldStop: () => stopped.now },
    );
    expect(outcomes.map((o) => o.name)).toEqual(["current"]);
  });

  it("passes a value through within the timeout", async () => {
    expect(await withTimeout(Promise.resolve(7), 50)).toBe(7);
  });
});

describe("purgeDue", () => {
  it("runs on the first tick, then once a day", () => {
    expect(purgeDue(undefined, 0)).toBe(true);
    expect(purgeDue(0, PURGE_EVERY_MS - 1)).toBe(false);
    expect(purgeDue(0, PURGE_EVERY_MS)).toBe(true);
  });
});
