import { describe, expect, it } from "vitest";
import { PortalResetItemKind, PortalResetRunState } from "@/lib/db-enums";
import {
  countsView,
  kindTone,
  kindWord,
  pageNumber,
  reasonText,
  stateTone,
  stateWord,
} from "./runs-view";

describe("runs view words", () => {
  it("has a word and a tone for every state and kind", () => {
    PortalResetRunState.options.forEach((s) => {
      expect(stateWord(s)).not.toBe("");
      expect(["info", "success", "neutral", "accent"]).toContain(stateTone(s));
    });
    PortalResetItemKind.options.forEach((k) => {
      expect(kindWord(k)).not.toBe("");
      expect(["info", "success", "neutral", "accent"]).toContain(kindTone(k));
    });
  });

  it("joins an abort reason and a sign in reason, and is null with neither", () => {
    expect(reasonText(null, null)).toBeNull();
    expect(reasonText("deadline", null)).toContain("2 hour");
    expect(reasonText("sign_in_failed", "timeout")).toContain("too long");
  });

  it("counts a dry run's would delete as deletes in the list", () => {
    expect(countsView({ deleted: 2, would_delete: 3, failed: 1 })).toEqual({
      deleted: 5,
      changed: 0,
      failed: 1,
    });
  });

  it.each([
    [undefined, 1],
    ["3", 3],
    ["0", 1],
    ["-2", 1],
    ["x", 1],
    ["1.5", 1],
    [["4", "5"], 4],
  ])("reads page %j as %i", (raw, want) => {
    expect(pageNumber(raw)).toBe(want);
  });
});
