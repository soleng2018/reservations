import { describe, expect, it } from "vitest";
import { ok, err } from "@/lib/result";
import {
  CHOICES_CLOSED,
  choicesReducer,
  groupNoticeKey,
} from "@/lib/group-choices-state";

const choice = (name: string, domain: string | null) => ({ name, domain });

describe("choicesReducer (spec 0017 AC-18)", () => {
  it("opens into loading", () => {
    const s = choicesReducer(CHOICES_CLOSED, { type: "open", id: 1 });
    expect(s).toEqual({ current: 1, loaded: { kind: "loading" } });
  });

  it("takes the answer of the current open", () => {
    const open = choicesReducer(CHOICES_CLOSED, { type: "open", id: 1 });
    const s = choicesReducer(open, {
      type: "answer",
      id: 1,
      result: ok([choice("A", "a.com")]),
    });
    expect(s.loaded).toEqual({
      kind: "ready",
      choices: [choice("A", "a.com")],
    });
  });

  it("ignores a late answer from an earlier open", () => {
    const first = choicesReducer(CHOICES_CLOSED, { type: "open", id: 1 });
    const second = choicesReducer(first, { type: "open", id: 2 });
    const s = choicesReducer(second, {
      type: "answer",
      id: 1,
      result: ok([choice("Old", "old.com")]),
    });
    expect(s).toBe(second);
  });

  it("ignores an answer that arrives after close, and drops the list", () => {
    const open = choicesReducer(CHOICES_CLOSED, { type: "open", id: 1 });
    const ready = choicesReducer(open, {
      type: "answer",
      id: 1,
      result: ok([choice("A", "a.com")]),
    });
    const closed = choicesReducer(ready, { type: "closed" });
    expect(closed).toEqual(CHOICES_CLOSED);
    expect(
      choicesReducer(closed, { type: "answer", id: 1, result: ok([]) }),
    ).toBe(closed);
  });

  it("is unavailable on an unavailable answer and when the call threw", () => {
    const open = choicesReducer(CHOICES_CLOSED, { type: "open", id: 1 });
    expect(
      choicesReducer(open, {
        type: "answer",
        id: 1,
        result: err("unavailable"),
      }).loaded,
    ).toEqual({ kind: "unavailable" });
    expect(
      choicesReducer(open, { type: "answer", id: 1, result: null }).loaded,
    ).toEqual({ kind: "unavailable" });
  });
});

describe("groupNoticeKey (spec 0017 AC-18, AC-22)", () => {
  it("says empty when there are no choices", () => {
    expect(groupNoticeKey([])).toBe("groupChoicesEmpty");
  });
  it("says no domain when every choice lacks one", () => {
    expect(groupNoticeKey([choice("A", null), choice("B", null)])).toBe(
      "groupChoicesNoDomain",
    );
  });
  it("says nothing when a choice has a domain", () => {
    expect(groupNoticeKey([choice("A", null), choice("B", "b.com")])).toBe(
      undefined,
    );
  });
});
