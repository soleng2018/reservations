import { describe, expect, it } from "vitest";
import { fullName } from "./full-name";

// covers: spec 0025 AC-1
describe("fullName", () => {
  const schema = fullName("Need both.");
  const messageFor = (v: unknown) => {
    const r = schema.safeParse(v);
    return r.success ? null : r.error.issues.map((i) => i.message);
  };

  it("trims and accepts a first and last name", () => {
    expect(schema.parse("  Ana de Souza ")).toBe("Ana de Souza");
  });

  it("refuses empty, one word, a non string, and a name over 200", () => {
    expect(messageFor("")).toEqual(["Need both."]);
    expect(messageFor("Ana")).toEqual(["Need both."]);
    expect(messageFor(1)).toEqual(["Need both."]);
    expect(messageFor(`${"a".repeat(100)} ${"b".repeat(100)}`)).toEqual([
      "Need both.",
    ]);
  });
});
