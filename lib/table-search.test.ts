import { describe, expect, it } from "vitest";
import { filterRows, matchesQuery, resultCount } from "./table-search";

describe("matchesQuery", () => {
  it("ignores case", () => {
    expect(matchesQuery("Basic 2 hours", "BASIC")).toBe(true);
  });

  it("trims the query", () => {
    expect(matchesQuery("Basic 2 hours", "  2 hou ")).toBe(true);
  });

  it("matches everything on an empty or blank query", () => {
    expect(matchesQuery("Basic", "")).toBe(true);
    expect(matchesQuery("Basic", "   ")).toBe(true);
  });

  it("is false when the query is not a substring", () => {
    expect(matchesQuery("Basic 2 hours", "advanced")).toBe(false);
  });
});

describe("filterRows", () => {
  const rows = [
    { id: "a", search: "Basic 2 hours" },
    { id: "b", search: "Advanced 1 day" },
  ];

  it("keeps the matching rows in order", () => {
    expect(filterRows(rows, "a").map((r) => r.id)).toEqual(["a", "b"]);
    expect(filterRows(rows, "day").map((r) => r.id)).toEqual(["b"]);
  });

  it("returns nothing when nothing matches", () => {
    expect(filterRows(rows, "zzz")).toEqual([]);
  });
});

describe("resultCount", () => {
  it("states the count", () => {
    expect(resultCount(0)).toBe("No results");
    expect(resultCount(1)).toBe("1 result");
    expect(resultCount(3)).toBe("3 results");
  });
});
