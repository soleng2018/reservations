import { describe, expect, it } from "vitest";
import raw from "@/db/seed/portal-reset-starting-list.json";
import { startingChoices } from "./starting-choices";
import { StartingList } from "./starting-list";

const file = StartingList.parse(raw);
const keys = file.steps.map((s) => s.key);

describe("startingChoices", () => {
  it("offers nothing when every entry is in the table", () => {
    expect(startingChoices(file, keys)).toEqual([]);
  });

  it("offers everything for an empty table, in file order, described", () => {
    const all = startingChoices(file, []);
    expect(all.map((c) => c.key)).toEqual(keys);
    expect(all.every((c) => c.description.length > 0)).toBe(true);
  });

  it("offers a removed entry again once its row is gone (AC-26)", () => {
    const without = keys.filter((k) => k !== "ssids");
    const offered = startingChoices(file, without);
    expect(offered.map((c) => c.key)).toEqual(["ssids"]);
    expect(offered[0]).toMatchObject({ featureName: "SSIDs", enabled: true });
  });

  it("ignores rows with no seed key, and keeps the disabled flag", () => {
    const offered = startingChoices(file, [null, null]);
    expect(offered).toHaveLength(keys.length);
    expect(offered.find((c) => c.key === "service-profiles")?.enabled).toBe(
      false,
    );
  });
});
