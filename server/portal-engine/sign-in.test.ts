import { describe, expect, it } from "vitest";
import { replyHeaders } from "@/server/portal-engine/sign-in";

describe("replyHeaders", () => {
  it("drops set-cookie, which Headers refuses when it holds several lines", () => {
    expect(
      replyHeaders({
        "content-type": "application/json",
        "set-cookie": "a=1\nb=2",
      }),
    ).toEqual({ "content-type": "application/json" });
  });
});
