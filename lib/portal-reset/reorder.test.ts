import { describe, expect, it } from "vitest";
import { moveItem, reorderAnnouncements } from "./reorder";

describe("moveItem", () => {
  const list = ["a", "b", "c", "d"];

  it("moves an item down and up", () => {
    expect(moveItem(list, 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(moveItem(list, 3, 1)).toEqual(["a", "d", "b", "c"]);
    expect(moveItem(list, 1, 0)).toEqual(["b", "a", "c", "d"]);
  });

  it("changes nothing for the same place or a place outside the list", () => {
    expect(moveItem(list, 2, 2)).toBe(list);
    expect(moveItem(list, -1, 2)).toBe(list);
    expect(moveItem(list, 1, 4)).toBe(list);
  });

  it("never changes its input", () => {
    moveItem(list, 0, 3);
    expect(list).toEqual(["a", "b", "c", "d"]);
  });
});

describe("reorderAnnouncements", () => {
  const rows = [
    { id: "x1", name: "Integrations" },
    { id: "x2", name: "SSIDs" },
    { id: "x3", name: "Segments" },
  ];
  const say = reorderAnnouncements(rows);

  it("names the row and its place when it is lifted", () => {
    expect(say.onDragStart({ active: { id: "x2" } })).toBe(
      "Picked up SSIDs, position 2 of 3.",
    );
  });

  it("names the place it moves over and is dropped at", () => {
    const event = { active: { id: "x2" }, over: { id: "x3" } };
    expect(say.onDragOver(event)).toBe("SSIDs moved to position 3 of 3.");
    expect(say.onDragEnd(event)).toBe("SSIDs dropped at position 3 of 3.");
  });

  it("says so when there is no place, and when it is cancelled", () => {
    expect(say.onDragOver({ active: { id: "x2" }, over: null })).toBe(
      "SSIDs is not over a place.",
    );
    expect(say.onDragEnd({ active: { id: "x2" } })).toBe(
      "SSIDs dropped where it was.",
    );
    expect(say.onDragCancel({ active: { id: "x2" } })).toBe(
      "Move cancelled. SSIDs is back at position 2 of 3.",
    );
  });
});
