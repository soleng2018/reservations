import { describe, expect, it } from "vitest";
import { fillBody, fillPath } from "./template";

const fill = {
  id: "a b/c",
  parentId: "p1",
  ids: ["x", "y"],
  reads: { w: { n: 5 } },
};

// covers: AC-20
describe("fillPath", () => {
  it("encodes ids in a path", () => {
    expect(fillPath("/api/v1/x/{parentId}/y/{id}", fill)).toEqual({
      ok: true,
      value: "/api/v1/x/p1/y/a%20b%2Fc",
    });
    expect(fillPath("/api/v1/z?size={read.w.n}", fill)).toEqual({
      ok: true,
      value: "/api/v1/z?size=5",
    });
  });
  it("is unresolved when a value is missing", () => {
    expect(fillPath("/api/{id}", { reads: {} }).ok).toBe(false);
    expect(fillPath("/api/{read.w.q}", fill).ok).toBe(false);
  });
});

describe("fillBody", () => {
  it("leaves ids as is and fills whole string placeholders", () => {
    expect(
      fillBody(
        { id: "{id}", ids: "{ids}", n: [{ v: "{read.w.n}" }], k: 1 },
        fill,
      ),
    ).toEqual({
      ok: true,
      value: { id: "a b/c", ids: ["x", "y"], n: [{ v: 5 }], k: 1 },
    });
  });
  it("is unresolved when a value is missing", () => {
    expect(fillBody({ a: ["{id}"] }, { reads: {} }).ok).toBe(false);
  });
});
