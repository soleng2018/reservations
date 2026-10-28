import { describe, expect, it } from "vitest";
import {
  canonicalDefinition,
  nameKey,
  normalizeEmail,
  nullIfEmpty,
  stableStringify,
} from "./normalize";

describe("normalize", () => {
  it("trims and turns empty into null", () => {
    expect(nullIfEmpty("  a ")).toBe("a");
    expect(nullIfEmpty("   ")).toBeNull();
    expect(nullIfEmpty(undefined)).toBeNull();
    expect(nullIfEmpty(null)).toBeNull();
  });

  it("lowercases an email", () => {
    expect(normalizeEmail("  Ops@Example.COM ")).toBe("ops@example.com");
    expect(normalizeEmail("")).toBeNull();
  });

  it("compares a feature name ignoring case and outer spaces", () => {
    expect(nameKey("  SSIDs ")).toBe(nameKey("ssids"));
  });

  it("sorts keys and drops undefined, so spacing and order do not matter", () => {
    expect(
      stableStringify({ b: 1, a: { d: [2, { y: 1, x: undefined }], c: null } }),
    ).toBe('{"a":{"c":null,"d":[2,{"y":1}]},"b":1}');
    expect(stableStringify(JSON.parse('{ "a" : 1,\n "b":2 }'))).toBe(
      stableStringify({ b: 2, a: 1 }),
    );
  });

  it("returns a definition in canonical form, or the error", () => {
    const ok = canonicalDefinition({ parts: [{ seconds: 5, kind: "wait" }] });
    expect(ok.ok && Object.keys(ok.value.parts[0] ?? {})).toEqual([
      "kind",
      "seconds",
    ]);
    expect(canonicalDefinition({ parts: [] }).ok).toBe(false);
  });
});
