import { describe, expect, it } from "vitest";
import {
  cleanPart,
  drawNumbers,
  localPart,
  nameWords,
  nileLoginCandidates,
} from "./nile-login";

const input = (name: string, email = "someone@x.test") => ({
  name,
  email,
  domain: "nileworkshop-1.com",
});

describe("cleanPart", () => {
  it("lowercases, strips accents, keeps a to z and 0 to 9", () => {
    expect(cleanPart("José")).toBe("jose");
    expect(cleanPart("O'Neil")).toBe("oneil");
    expect(cleanPart("Zoë-2")).toBe("zoe2");
  });
  it("cuts to 30 characters", () => {
    expect(cleanPart("a".repeat(45))).toHaveLength(30);
  });
  it("is empty for a name with no latin letters", () => {
    expect(cleanPart("山田")).toBe("");
  });
});

describe("nameWords", () => {
  it("takes the first and last word", () => {
    expect(nameWords("Ana Maria de Souza")).toEqual({
      first: "Ana",
      last: "Souza",
    });
  });
  it("has no last name for one word", () => {
    expect(nameWords("  Prince ")).toEqual({ first: "Prince", last: null });
  });
});

describe("nileLoginCandidates", () => {
  it("builds first.last@domain (AC-1)", () => {
    expect(nileLoginCandidates(input("Ana Maria de Souza"), [])).toEqual([
      "ana.souza@nileworkshop-1.com",
    ]);
  });
  it("uses the first name only for one word", () => {
    expect(nileLoginCandidates(input("Prince"), [])).toEqual([
      "prince@nileworkshop-1.com",
    ]);
  });
  it("strips accents and punctuation", () => {
    expect(nileLoginCandidates(input("José O'Neil"), [])).toEqual([
      "jose.oneil@nileworkshop-1.com",
    ]);
  });
  it("treats a last name that cleans to nothing as absent", () => {
    expect(nileLoginCandidates(input("Ana 山田"), [])).toEqual([
      "ana@nileworkshop-1.com",
    ]);
  });
  it("falls back to the email part when the first name cleans to nothing", () => {
    expect(
      nileLoginCandidates(input("山田 太郎", "Taro.Y@x.test"), []),
    ).toEqual(["taroy@nileworkshop-1.com"]);
  });
  it("uses learner with a number when nothing is left", () => {
    expect(localPart("山田", "山田@x.test")).toEqual({
      local: "learner",
      plain: false,
    });
    expect(nileLoginCandidates(input("山田", "山田@x.test"), [4821])).toEqual([
      "learner4821@nileworkshop-1.com",
    ]);
  });
  it("appends the draws to the name part, after the plain login (AC-2)", () => {
    expect(nileLoginCandidates(input("Ana Souza"), [4821, 1000])).toEqual([
      "ana.souza@nileworkshop-1.com",
      "ana.souza4821@nileworkshop-1.com",
      "ana.souza1000@nileworkshop-1.com",
    ]);
    expect(nileLoginCandidates(input("Ana"), [4821])).toEqual([
      "ana@nileworkshop-1.com",
      "ana4821@nileworkshop-1.com",
    ]);
  });
  it("keeps the name part within 64 characters with a number", () => {
    const long = `${"a".repeat(30)} ${"b".repeat(30)}`;
    const [plain, withNumber] = nileLoginCandidates(input(long), [4821]);
    expect(plain?.split("@")[0]).toHaveLength(61);
    expect(withNumber?.split("@")[0]).toHaveLength(64);
    expect(withNumber?.split("@")[0]?.endsWith("4821")).toBe(true);
  });
  it("lowercases the domain", () => {
    expect(
      nileLoginCandidates({ ...input("Ana"), domain: "Nile.Global" }, []),
    ).toEqual(["ana@nile.global"]);
  });
});

describe("drawNumbers", () => {
  it("returns the asked count of distinct numbers in range", () => {
    const seq = [0, 0, 5, 8999, 5, 7];
    const next = () => seq.shift() ?? 1;
    const drawn = drawNumbers(4, next);
    expect(drawn).toEqual([1000, 1005, 9999, 1007]);
  });
});
