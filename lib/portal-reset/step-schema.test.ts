import { describe, expect, it } from "vitest";
import { fieldErrors } from "@/lib/form-errors";
import { StepDefinition, looksSecret, portalPathProblem } from "./step-schema";

const list = {
  method: "GET",
  path: "/api/v1/things?size=2000",
  itemsAt: "data.content",
  idField: "id",
  labelField: "name",
};
const deleteEach = {
  kind: "delete_each",
  list,
  delete: { path: "/api/v1/things/{id}" },
};
const stateRead = {
  kind: "read",
  as: "state",
  method: "GET",
  path: "/api/v1/state",
  pick: { id: "[0].id", on: "[0].enabled" },
};

const errorsOf = (definition: unknown) => {
  const result = StepDefinition.safeParse(definition);
  return result.success ? null : fieldErrors(result.error);
};
const step = (...parts: readonly unknown[]) => ({ parts });

// One fixture for each of the 14 needs in the research note, section 4.
describe("the step language accepts every need", () => {
  const fixtures: readonly (readonly [string, unknown])[] = [
    [
      "skip an item by a field value",
      step({
        ...deleteEach,
        skipWhen: [{ field: "ssid.popTunnelUsed", op: "eq", value: true }],
      }),
    ],
    [
      "set a value with a body",
      step({
        kind: "call",
        method: "PUT",
        path: "/api/v1/guestpop/advance/abc",
        body: { advanceSettingsEnabled: true },
      }),
    ],
    [
      "branch on a state read",
      step(stateRead, {
        kind: "call",
        method: "PUT",
        path: "/api/v1/state/{read.state.id}",
        body: { id: "{read.state.id}", on: false },
        when: [{ read: "state", key: "on", op: "eq", value: true }],
      }),
    ],
    ["a pause", step({ kind: "wait", seconds: 10 })],
    [
      "delete with a list of ids in the body",
      step({
        ...deleteEach,
        delete: {
          path: "/api/v1/client-configs",
          batch: true,
          body: { ids: "{ids}" },
        },
      }),
    ],
    [
      "a delete with no id",
      step({ kind: "call", method: "DELETE", path: "/api/v1/settings/sso" }),
    ],
    [
      "parent ids in the path",
      step({
        kind: "delete_each",
        list: {
          ...list,
          nested: { at: "policies", parentIdField: "id" },
        },
        delete: {
          path: "/api/v3/sets/{parentId}/rules/{id}",
          body: { id: "{id}", policySetId: "{parentId}" },
        },
      }),
    ],
    [
      "a step of several parts",
      step(stateRead, deleteEach, { kind: "wait", seconds: 1 }),
    ],
    [
      "an expected refusal",
      step({
        ...deleteEach,
        expectRefusals: [{ status: 400, messageContains: "Group belongs" }],
      }),
    ],
    [
      "an update of a parent record",
      step({
        kind: "update_record",
        list,
        match: [{ field: "dhcpClient.servers[0].subnets", op: "nonEmpty" }],
        set: { at: "dhcpClient.servers[0].subnets", value: [] },
        put: { path: "/api/v1/dhcp/{id}" },
      }),
    ],
    [
      "a list read done by POST",
      step({
        ...deleteEach,
        list: { ...list, method: "POST", body: { search: {} } },
      }),
    ],
    [
      "an expected end state",
      step(stateRead, {
        kind: "expect",
        read: "state",
        key: "on",
        op: "eq",
        value: false,
      }),
    ],
    [
      "a read that keeps only chosen scalar fields",
      step({
        ...stateRead,
        pick: { usable: "usable", done: "eapTLSConfig.complete" },
      }),
    ],
    [
      "an item with no label",
      step({ ...deleteEach, list: { ...list, labelField: undefined } }),
    ],
  ];

  it.each(fixtures)("%s", (_need, definition) => {
    expect(errorsOf(definition)).toBeNull();
  });

  it("holds exactly the 14 needs", () => {
    expect(fixtures).toHaveLength(14);
  });
});

describe("AC-9: a definition is refused, keyed by dotted path", () => {
  const at = (definition: unknown, path: string) =>
    errorsOf(definition)?.[path];

  it("refuses no parts and too many parts", () => {
    expect(errorsOf({ parts: [] })).toHaveProperty("parts");
    const waits = Array.from({ length: 13 }, () => ({
      kind: "wait",
      seconds: 1,
    }));
    expect(errorsOf({ parts: waits })).toHaveProperty("parts");
  });

  it("refuses a wait over 60 seconds, and waits over 60 in total", () => {
    expect(
      at(step({ kind: "wait", seconds: 61 }), "parts.0.seconds"),
    ).toBeDefined();
    const total = step(
      { kind: "wait", seconds: 40 },
      { kind: "wait", seconds: 30 },
    );
    expect(at(total, "parts")).toMatch(/60 seconds in total/);
  });

  it("refuses a definition over 20 000 characters", () => {
    const big = step({
      kind: "call",
      method: "PUT",
      path: "/api/v1/x",
      body: { a: Array.from({ length: 600 }, () => "x".repeat(40)) },
    });
    expect(at(big, "parts")).toMatch(/20 000/);
  });

  it.each([
    ["a host", "https://evil.example/api/v1/x"],
    ["not under /api/", "/v1/x"],
    ["..", "/api/v1/../x"],
    ["//", "/api//x"],
    ["#", "/api/v1/x#a"],
    ["a space", "/api/v1/x y"],
    ["a query on a delete", "/api/v1/x/{id}?force=true"],
    ["an unknown placeholder", "/api/v1/{tenant}/{id}"],
    ["a placeholder inside a segment", "/api/v1/a{id}"],
    ["the deny list", "/api/v1/idps/{id}"],
    ["users", "/api/v2/users/{id}"],
    ["200+ characters", `/api/${"a".repeat(200)}/{id}`],
  ])("refuses a delete path with %s", (_why, path) => {
    const definition = step({ ...deleteEach, delete: { path } });
    expect(at(definition, "parts.0.delete.path")).toBeDefined();
  });

  it("refuses a list path with a placeholder other than a read one", () => {
    const definition = step({
      ...deleteEach,
      list: { ...list, path: "/api/v1/x/{id}" },
    });
    expect(at(definition, "parts.0.list.path")).toMatch(/only for a delete/);
  });

  it("refuses an unknown placeholder in a query value, a path, or a body", () => {
    const read = (path: string) => step({ ...stateRead, path });
    expect(errorsOf(read("/api/v1/x?q={evil}"))).toHaveProperty("parts.0.path");
    expect(errorsOf(read("/api/v1/x/{evil}"))).not.toBeNull();
    expect(
      errorsOf(
        step({
          kind: "call",
          method: "PUT",
          path: "/api/v1/x",
          body: { a: "{evil}" },
        }),
      ),
    ).not.toBeNull();
    expect(errorsOf(read("/api/v1/x?q={read.state.id}"))).not.toBeNull(); // no earlier read
  });

  it("allows a query on a list and on a read", () => {
    expect(
      portalPathProblem("/api/v1/x?page=0&size=500", { query: true }),
    ).toBeNull();
    expect(portalPathProblem("/api/v1/x?page", { query: true })).not.toBeNull();
  });

  it("refuses a denied page route, a bad route, and more than 5 pages", () => {
    const parts = [{ kind: "wait", seconds: 1 }];
    expect(
      at({ parts, pages: ["/global-settings/identity"] }, "pages.0"),
    ).toBeDefined();
    expect(at({ parts, pages: ["network-setup"] }, "pages.0")).toBeDefined();
    expect(at({ parts, pages: ["/api/v1/x"] }, "pages.0")).toBeDefined();
    const six = Array.from({ length: 6 }, (_, i) => `/page-${i}`);
    expect(errorsOf({ parts, pages: six })).toHaveProperty("pages");
    expect(errorsOf({ parts, pages: ["/network-setup/wireless"] })).toBeNull();
  });

  it("refuses a method that is not allowed in its place", () => {
    expect(
      at(
        step({ ...deleteEach, list: { ...list, method: "DELETE" } }),
        "parts.0.list.method",
      ),
    ).toBeDefined();
    expect(
      at(
        step({ kind: "call", method: "PATCH", path: "/api/v1/x" }),
        "parts.0.method",
      ),
    ).toBeDefined();
    expect(
      at(
        step({ kind: "call", method: "GET", path: "/api/v1/x" }),
        "parts.0.method",
      ),
    ).toBeDefined();
  });

  it("refuses {parentId} with no nested, {ids} outside a batch delete", () => {
    const parent = step({
      ...deleteEach,
      delete: { path: "/api/v1/{parentId}/{id}" },
    });
    expect(at(parent, "parts.0.delete.path")).toMatch(/nested/);
    const ids = step({
      ...deleteEach,
      delete: { path: "/api/v1/x/{id}", body: { ids: "{ids}" } },
    });
    expect(at(ids, "parts.0.delete.body")).toMatch(/batch/);
  });

  it("holds a batch delete to {ids}, and a plain delete to {id}", () => {
    const noIds = step({
      ...deleteEach,
      delete: { path: "/api/v1/x", batch: true },
    });
    expect(at(noIds, "parts.0.delete.body")).toMatch(/\{ids\}/);
    const noId = step({ ...deleteEach, delete: { path: "/api/v1/x" } });
    expect(at(noId, "parts.0.delete.path")).toMatch(/\{id\}/);
  });

  it("refuses a read that comes later, or a key the read does not pick", () => {
    const later = step(
      {
        kind: "wait",
        seconds: 1,
        when: [{ read: "state", key: "on", op: "eq", value: true }],
      },
      stateRead,
    );
    expect(at(later, "parts.0.when.0.read")).toMatch(/earlier/);
    const key = step(stateRead, {
      kind: "call",
      method: "PUT",
      path: "/api/v1/x/{read.state.nope}",
    });
    expect(at(key, "parts.1.path")).toMatch(/does not pick/);
    const self = step({ ...stateRead, path: "/api/v1/x/{read.state.id}" });
    expect(at(self, "parts.0.path")).toMatch(/earlier/);
  });

  it("refuses an expect on an unknown read, and a repeated read name", () => {
    expect(
      at(
        step({ kind: "expect", read: "x", key: "y", op: "exists" }),
        "parts.0.read",
      ),
    ).toBeDefined();
    expect(at(step(stateRead, stateRead), "parts.1.as")).toMatch(/already/);
  });

  it("refuses an operator with the wrong value", () => {
    const rules = (r: unknown) => step({ ...deleteEach, skipWhen: [r] });
    expect(
      at(rules({ field: "a", op: "eq" }), "parts.0.skipWhen.0.value"),
    ).toBeDefined();
    expect(
      at(rules({ field: "a", op: "in", value: 1 }), "parts.0.skipWhen.0.value"),
    ).toBeDefined();
    expect(
      at(
        rules({ field: "a", op: "exists", value: 1 }),
        "parts.0.skipWhen.0.value",
      ),
    ).toBeDefined();
    expect(
      at(rules({ field: "a", op: "like", value: 1 }), "parts.0.skipWhen.0.op"),
    ).toBeDefined();
    expect(
      errorsOf(rules({ field: "a", op: "in", value: ["x", 2] })),
    ).toBeNull();
  });

  it("refuses an unknown key, which closes the language", () => {
    expect(
      errorsOf(step({ kind: "wait", seconds: 1, script: "x" })),
    ).not.toBeNull();
    expect(
      errorsOf({ parts: [{ kind: "wait", seconds: 1 }], extra: 1 }),
    ).not.toBeNull();
    expect(errorsOf(step({ kind: "eval", code: "1" }))).not.toBeNull();
  });
});

// AC-25: no secrets, headers, or portal data in a definition.
describe("AC-25: a definition holds no secret", () => {
  const withBody = (body: unknown) =>
    step({ kind: "call", method: "PUT", path: "/api/v1/x", body });

  it.each([
    "password",
    "token",
    "secret",
    "authorization",
    "cookie",
    "key",
    "apiKey",
    "client_secret",
    "Auth-Token",
  ])("refuses a body key named %s", (key) => {
    expect(errorsOf(withBody({ nested: { [key]: "x" } }))).toHaveProperty(
      `parts.0.body.nested.${key}`,
    );
  });

  it("allows a key that only contains the letters of a secret word", () => {
    expect(
      errorsOf(withBody({ monkey: 1, tokens: 1, keyboard: 2 })),
    ).toBeNull();
    expect(looksSecret("keyName")).toBe(true);
    expect(looksSecret("monkey")).toBe(false);
  });

  it("refuses any header, because the language has no header key", () => {
    const withHeader = step({
      kind: "call",
      method: "PUT",
      path: "/api/v1/x",
      headers: { "x-id-token": "a" },
    });
    expect(errorsOf(withHeader)).not.toBeNull();
  });

  it("refuses a body string that is not a whole placeholder", () => {
    expect(errorsOf(withBody({ a: "id is {id}" }))).toHaveProperty(
      "parts.0.body.a",
    );
    expect(errorsOf(withBody({ a: "{other}" }))).toHaveProperty(
      "parts.0.body.a",
    );
  });

  it("refuses a pick named like a secret", () => {
    const pick = step({ ...stateRead, pick: { token: "[0].t" } });
    expect(errorsOf(pick)).toHaveProperty("parts.0.pick.token");
  });

  it("refuses a pick that is not a path", () => {
    expect(errorsOf(step({ ...stateRead, pick: { a: "x y" } }))).toHaveProperty(
      "parts.0.pick.a",
    );
    expect(errorsOf(step({ ...stateRead, pick: {} }))).toHaveProperty(
      "parts.0.pick",
    );
  });
  it("refuses a pick path, and a list label, that reads a secret field", () => {
    expect(
      errorsOf(step({ ...stateRead, pick: { v: "[0].password" } })),
    ).toHaveProperty("parts.0.pick.v");
    expect(
      errorsOf(
        step({
          ...deleteEach,
          list: { ...list, labelField: "config.secret" },
        }),
      ),
    ).toHaveProperty("parts.0.list.labelField");
  });

  it("allows an ordinary pick path and label", () => {
    expect(
      errorsOf(step({ ...stateRead, pick: { v: "[0].name" } })),
    ).toBeNull();
    expect(
      errorsOf(step({ ...deleteEach, list: { ...list, labelField: "name" } })),
    ).toBeNull();
  });
});
