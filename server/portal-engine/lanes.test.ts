import { describe, expect, it } from "vitest";
import type { ClaimedRun } from "./claim";
import { runLanes } from "./lanes";

const run = (id: string): ClaimedRun => ({
  id,
  testbedId: "t",
  bookingId: null,
  mode: "live",
  labEndedAt: new Date(0),
  resumes: 0,
});

// covers: AC-5, AC-11
describe("runLanes", () => {
  it("runs each claimed run, pauses when idle, and stops on the signal", async () => {
    const queue = [run("a"), run("b"), run("c")];
    const done: string[] = [];
    const pauses: number[] = [];
    let stop = false;
    await runLanes(
      {
        claim: async () => queue.shift(),
        execute: async (r) => {
          done.push(r.id);
        },
        pause: async (ms) => {
          pauses.push(ms);
          stop = true;
        },
        log: () => undefined,
      },
      { lanes: 2, shouldStop: () => stop },
    );
    expect(done.sort()).toEqual(["a", "b", "c"]);
    expect(pauses.length).toBeGreaterThan(0);
    expect(pauses.every((p) => p === 15_000)).toBe(true);
  });

  it("logs a failing lane by error name only and goes on", async () => {
    const lines: string[] = [];
    let n = 0;
    let stop = false;
    await runLanes(
      {
        claim: async () => {
          n += 1;
          if (n === 1) throw new TypeError("secret portal text");
          stop = true;
          return undefined;
        },
        execute: async () => undefined,
        pause: async () => undefined,
        log: (l) => lines.push(l),
      },
      { lanes: 1, shouldStop: () => stop },
    );
    expect(lines).toEqual(["portal reset lane 1: TypeError"]);
  });
});
