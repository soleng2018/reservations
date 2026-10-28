import { describe, expect, it } from "vitest";
import { classify, retryDelay } from "./classify";

const reply = (status: number, message = "") =>
  ({ kind: "reply", status, message }) as const;

// covers: AC-21
describe("classify", () => {
  it.each([
    ["delete", reply(204), {}, "done"],
    ["delete", reply(200), { okStatus: [204] }, "failed"],
    ["delete", reply(404), {}, "gone"],
    ["list", reply(404), {}, "nothing"],
    ["read", reply(403), { emptyOn: [403] }, "nothing"],
    ["list", reply(200), {}, "done"],
    [
      "write",
      reply(400, "Cannot delete the DEFAULT thing"),
      { expectRefusals: [{ status: 400, messageContains: "default thing" }] },
      "expected",
    ],
    [
      "write",
      reply(400, "other"),
      { expectRefusals: [{ status: 400, messageContains: "default" }] },
      "failed",
    ],
    ["write", reply(429), {}, "retry"],
    ["write", reply(500), {}, "retry"],
    ["write", reply(503), {}, "retry"],
    ["write", reply(409), {}, "failed"],
    ["write", reply(302), {}, "failed"],
    ["write", { kind: "network" }, {}, "retry"],
    ["write", { kind: "timeout" }, {}, "retry"],
    ["write", { kind: "redirect" }, {}, "failed"],
    ["write", { kind: "oversize" }, {}, "failed"],
    ["write", reply(404), {}, "failed"],
  ] as const)("%s %j %j is %s", (verb, outcome, expect_, want) => {
    expect(classify(verb, outcome, expect_)).toBe(want);
  });

  it("waits 2 s then 6 s, then stops after 3 attempts", () => {
    expect([1, 2, 3].map(retryDelay)).toEqual([2000, 6000, null]);
  });
});
