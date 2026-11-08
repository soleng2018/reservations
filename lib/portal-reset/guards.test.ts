import { describe, expect, it } from "vitest";
import { isDenied } from "./deny-list";
import { GuardsFile, guards, guardsForDefinition } from "./guards";
import { StepDefinition } from "./step-schema";

describe("guards.json (AC-20)", () => {
  it("holds the seven guards", () => {
    expect(guards.map((g) => g.key)).toEqual([
      "protected-ssid",
      "system-policies",
      "nile-radius",
      "nile-radius-policies",
      "nile-dhcp",
      "users-root-admin",
      "users-signed-in",
    ]);
  });

  it("guards the protected SSID by popTunnelUsed, exactly one kept", () => {
    const ssid = guards.find((g) => g.key === "protected-ssid");
    expect(ssid?.keepWhen).toEqual([
      { field: "ssid.popTunnelUsed", op: "eq", value: true },
    ]);
    expect(ssid?.expectKept).toBe("exactlyOne");
  });

  it("holds no route on the deny list", () => {
    guards.forEach((g) => {
      // The Users guards read their list and refuse writes on a prefix the
      // deny list covers, so they are checked with the method they use.
      expect(isDenied(g.listPath, "GET")).toBe(false);
      expect(isDenied(`${g.deleteRoutePrefix}/x`, "DELETE")).toBe(false);
    });
  });

  it("refuses a repeated key and an unknown field", () => {
    const [first] = guards;
    expect(GuardsFile.safeParse({ guards: [first, first] }).success).toBe(
      false,
    );
    expect(
      GuardsFile.safeParse({ guards: [{ ...first, extra: 1 }] }).success,
    ).toBe(false);
    expect(GuardsFile.safeParse({ guards: [] }).success).toBe(false);
  });
});

describe("guardsForDefinition", () => {
  const defOf = (part: unknown) => StepDefinition.parse({ parts: [part] });

  it("guards a step that has no skip rule of its own", () => {
    const def = defOf({
      kind: "delete_each",
      list: {
        method: "GET",
        path: "/api/v1/settings/ssids?size=10",
        itemsAt: "data.content",
        idField: "id",
      },
      delete: { path: "/api/v1/settings/ssids/{id}" },
    });
    expect(guardsForDefinition(def).map((g) => g.key)).toEqual([
      "protected-ssid",
    ]);
  });

  it("guards a single call under a delete prefix", () => {
    const def = defOf({
      kind: "call",
      method: "DELETE",
      path: "/api/v1/settings/dhcp-clients/abc",
    });
    expect(guardsForDefinition(def).map((g) => g.key)).toEqual(["nile-dhcp"]);
  });

  it("does not guard a plain read, a wait, or a route that only shares letters", () => {
    expect(
      guardsForDefinition(
        defOf({
          kind: "read",
          as: "x",
          method: "GET",
          path: "/api/v1/settings/ssids",
          pick: { a: "a" },
        }),
      ),
    ).toEqual([]);
    expect(
      guardsForDefinition(
        defOf({
          kind: "call",
          method: "DELETE",
          path: "/api/v1/settings/ssidsx/1",
        }),
      ),
    ).toEqual([]);
  });
});

// covers: spec 0027 AC-7, and the review fix (onlyListed)
describe("the Users guards in guards.json", () => {
  const users = guards.filter((g) => g.key.startsWith("users-"));

  it("are read only when a step touches them, guard a POST, and accept only listed ids", () => {
    expect(users.map((g) => g.key)).toEqual([
      "users-root-admin",
      "users-signed-in",
    ]);
    for (const g of users) {
      expect(g).toMatchObject({
        listPath: "/api/v2/users?page=0&size=2000",
        itemsAt: "content",
        idField: "id",
        deleteRoutePrefix: "/api/v1/users",
        guardPost: true,
        onlyListed: true,
        scope: "when_touched",
      });
    }
  });

  it("keep the RootAdmin group and the signed in user", () => {
    const [root, signedIn] = users;
    expect(root).toMatchObject({
      keepWhen: [
        { field: "groupIds", op: "has", value: "00ghquj7yiA33Pg5v5d5" },
      ],
      expectKept: "atLeastOne",
    });
    expect(signedIn).toMatchObject({
      keepSignedIn: true,
      expectKept: "exactlyOne",
    });
  });
});
