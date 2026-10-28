import { describe, expect, it } from "vitest";
import {
  getPortalPath,
  isPortalPath,
  isScalar,
  parsePortalPath,
} from "./portal-path";

describe("parsePortalPath", () => {
  it("reads dot segments and indexes", () => {
    expect(parsePortalPath("data.content")).toEqual(["data", "content"]);
    expect(parsePortalPath("[0].id")).toEqual([0, "id"]);
    expect(parsePortalPath("dhcpClient.servers[0].subnets")).toEqual([
      "dhcpClient",
      "servers",
      0,
      "subnets",
    ]);
    expect(parsePortalPath("a[1][2]")).toEqual(["a", 1, 2]);
  });

  it("treats $ as the root, alone or as a prefix", () => {
    expect(parsePortalPath("$")).toEqual([]);
    expect(parsePortalPath("$.data")).toEqual(["data"]);
    expect(parsePortalPath("$[0].id")).toEqual([0, "id"]);
  });

  it.each(["", ".a", "a.", "a..b", "$a", "a[", "a[x]", "a b", "a/b", "a()"])(
    "refuses %j",
    (text) => {
      expect(isPortalPath(text)).toBe(false);
    },
  );

  it("refuses a path that is too long or too deep", () => {
    expect(isPortalPath("a".repeat(201))).toBe(false);
    expect(isPortalPath(Array.from({ length: 13 }, () => "a").join("."))).toBe(
      false,
    );
  });
});

describe("getPortalPath", () => {
  const reply = {
    data: { content: [{ id: "a" }, { id: "b" }] },
    flag: false,
    none: null,
  };

  it("walks objects and arrays", () => {
    expect(getPortalPath(reply, "data.content[1].id")).toBe("b");
    expect(getPortalPath(reply, "flag")).toBe(false);
    expect(getPortalPath([{ id: 1 }], "[0].id")).toBe(1);
    expect(getPortalPath(reply, "$")).toBe(reply);
  });

  it("gives undefined for anything missing, never an error", () => {
    expect(getPortalPath(reply, "data.nope.deeper")).toBeUndefined();
    expect(getPortalPath(reply, "data.content[9].id")).toBeUndefined();
    expect(getPortalPath(reply, "none.x")).toBeUndefined();
    expect(getPortalPath(reply, "not a path")).toBeUndefined();
    expect(getPortalPath(undefined, "a")).toBeUndefined();
  });

  it("never resolves inherited properties", () => {
    expect(getPortalPath({}, "constructor")).toBeUndefined();
    expect(getPortalPath({}, "__proto__")).toBeUndefined();
  });
});

describe("isScalar", () => {
  it("accepts string, number, boolean, and null only", () => {
    expect([null, "a", 1, true].every(isScalar)).toBe(true);
    expect([undefined, {}, []].some(isScalar)).toBe(false);
  });
});
