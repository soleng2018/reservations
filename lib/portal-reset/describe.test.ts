import { describe, expect, it } from "vitest";
import { describeStep } from "./describe";
import { StepDefinition } from "./step-schema";

const parse = (parts: readonly unknown[]) => StepDefinition.parse({ parts });
const list = {
  method: "GET",
  path: "/api/v1/settings/ssids",
  itemsAt: "data.content",
  idField: "id",
};

describe("describeStep (AC-24)", () => {
  it("describes a delete of each item with a skip rule", () => {
    const [line] = describeStep(
      parse([
        {
          kind: "delete_each",
          list,
          delete: { path: "/api/v1/settings/ssids/{id}" },
          skipWhen: [{ field: "ssid.popTunnelUsed", op: "eq", value: true }],
        },
      ]),
    );
    expect(line).toBe(
      "Read GET /api/v1/settings/ssids, delete each item with DELETE /api/v1/settings/ssids/{id}, skipping items where ssid.popTunnelUsed is true.",
    );
  });

  it("describes reads, calls, waits, expects, and conditions", () => {
    const lines = describeStep(
      parse([
        {
          kind: "read",
          as: "state",
          method: "GET",
          path: "/api/v1/s",
          pick: { id: "[0].id", on: "[0].on" },
        },
        {
          kind: "call",
          method: "PUT",
          path: "/api/v1/s/{read.state.id}",
          body: { on: true },
          when: [{ read: "state", key: "on", op: "eq", value: false }],
        },
        { kind: "wait", seconds: 10 },
        { kind: "wait", seconds: 1 },
        { kind: "expect", read: "state", key: "on", op: "missing" },
      ]),
    );
    expect(lines).toEqual([
      "Read GET /api/v1/s and keep id, on as state.",
      "Call PUT /api/v1/s/{read.state.id} with a body, only when state.on is false.",
      "Wait 10 seconds.",
      "Wait 1 second.",
      "Check that state.on is not set.",
    ]);
  });

  it("describes a batch delete, a nested list, and expected refusals", () => {
    const [line] = describeStep(
      parse([
        {
          kind: "delete_each",
          list: { ...list, nested: { at: "policies", parentIdField: "id" } },
          delete: { path: "/api/v1/x", batch: true, body: { ids: "{ids}" } },
          onlyWhen: [{ field: "groupType", op: "in", value: ["App", "User"] }],
          expectRefusals: [{ status: 400, messageContains: "x" }],
        },
      ]),
    );
    expect(line).toContain("(the items inside each record, in policies)");
    expect(line).toContain(
      "delete all the items in one call with DELETE /api/v1/x",
    );
    expect(line).toContain(
      'only items where groupType is one of "App", "User"',
    );
    expect(line).toContain("expecting the portal to refuse some with 400");
  });

  it("describes an update of a record", () => {
    const [line] = describeStep(
      parse([
        {
          kind: "update_record",
          list,
          match: [{ field: "a.b", op: "nonEmpty" }],
          set: { at: "a.b", value: [] },
          put: { path: "/api/v1/x/{id}" },
        },
      ]),
    );
    expect(line).toBe(
      "Read GET /api/v1/settings/ssids, and in each record where a.b is not empty set a.b to [] and PUT it back to /api/v1/x/{id}.",
    );
  });
});
