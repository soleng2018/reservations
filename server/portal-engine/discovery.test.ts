import { describe, expect, it } from "vitest";
import { ok } from "@/lib/result";
import { DISCOVERY_BUDGET } from "@/lib/portal-reset/timing";
import type { Candidate } from "@/lib/portal-reset/discovery-rules";
import {
  runDiscovery,
  type Collector,
  type DiscoveryDeps,
  type PageCapture,
} from "./discovery";
import type { ItemRecord, StepEnv } from "./interpret";
import type { PortalClient, PortalRequest } from "./portal";

type Rec = Record<string, unknown>;

// A portal with a few lists, each GET and DELETE <list>/<id>. `deleteStatus`
// forces the answer a delete gives (a 405 for "the convention does not hold").
function table(lists: Record<string, { rows: Rec[]; deleteStatus?: number }>) {
  const writes: PortalRequest[] = [];
  const client: PortalClient = {
    close: async () => undefined,
    call: async (req) => {
      const path = req.path.split("?")[0] ?? "";
      if (req.method === "GET") {
        const t = lists[path];
        return ok(
          t
            ? { status: 200, body: { data: { content: t.rows } } }
            : { status: 404, body: {} },
        );
      }
      writes.push(req);
      const at = Object.keys(lists).find((p) => path.startsWith(`${p}/`));
      const t = at === undefined ? undefined : lists[at];
      if (!t || at === undefined) return ok({ status: 404, body: {} });
      if (t.deleteStatus !== undefined)
        return ok({ status: t.deleteStatus, body: {} });
      const id = decodeURIComponent(path.slice(at.length + 1));
      t.rows.splice(
        t.rows.findIndex((r) => r.id === id),
        1,
      );
      return ok({ status: 200, body: {} });
    },
  };
  return { client, writes };
}

const list = (
  path: string,
  rows: Rec[],
  over: Partial<Omit<Candidate, "records">> = {},
): PageCapture["lists"][number] => ({
  method: "GET",
  route: path,
  path,
  itemsAt: "data.content",
  records: rows,
  ...over,
});

const run = (
  pages: Record<string, PageCapture | "timeout">,
  portal: PortalClient,
  over: Partial<DiscoveryDeps> = {},
  mode: StepEnv["mode"] = "live",
) => {
  const records: ItemRecord[] = [];
  const collect: Collector = async (page) => pages[page] ?? "timeout";
  const env: StepEnv = {
    portal,
    mode,
    pass: 1,
    sleep: async () => undefined,
    beforeWrite: async () => undefined,
    isGuarded: () => false,
    record: (r) => records.push(r),
    hidden: new Set(),
  };
  const done = runDiscovery({
    collect,
    env,
    pages: Object.keys(pages),
    covered: [],
    elapsedMs: () => 0,
    ...over,
  });
  return { done, records };
};

const capture = (
  page: string,
  text: string,
  lists: PageCapture["lists"],
): PageCapture => ({ page, text, lists });

const found = (records: readonly ItemRecord[]) =>
  records.filter((r) => r.kind === "route_found");

describe("discovery (AC-35 to AC-38)", () => {
  it("finds a new list shown on its page, deletes it by convention, and re-reads it", async () => {
    const t = table({
      "/api/v1/gadgets": {
        rows: [
          { id: "g1", name: "Lab gadget" },
          { id: "g2", name: "Other gadget" },
        ],
      },
    });
    const { done, records } = run(
      {
        "/p/one": capture("/p/one", "Lab gadget Other gadget", [
          list("/api/v1/gadgets", [
            { id: "g1", name: "Lab gadget" },
            { id: "g2", name: "Other gadget" },
          ]),
        ]),
      },
      t.client,
    );
    const result = await done;
    expect(result.failed).toBe(false);
    expect(t.writes.map((w) => `${w.method} ${w.path}`)).toEqual([
      "DELETE /api/v1/gadgets/g1",
      "DELETE /api/v1/gadgets/g2",
    ]);
    const route = found(records);
    expect(route).toHaveLength(1);
    expect(route[0]).toMatchObject({
      stepKey: "discovery",
      method: "DELETE",
      route: "/api/v1/gadgets/{id}",
      detail: {
        page: "/p/one",
        found: 2,
        deleted: 2,
        left: 0,
        outcome: "deleted",
      },
    });
    expect(records.filter((r) => r.kind === "deleted")).toHaveLength(2);
  });

  it("never deletes a system record, a related route, a POST list, a long list, or an unshown list", async () => {
    const many = Array.from({ length: 26 }, (_v, i) => ({
      id: `m${i}`,
      name: "Many",
    }));
    const t = table({
      "/api/v1/sys": { rows: [{ id: "s1", name: "Builtin", isDefault: true }] },
      "/api/v1/parent": { rows: [{ id: "p1", name: "Parent" }] },
      "/api/v1/parent/{id}/child": { rows: [{ id: "c1", name: "Child" }] },
      "/api/v1/posted": { rows: [{ id: "x1", name: "Posted" }] },
      "/api/v1/many": { rows: many },
      "/api/v1/hidden": { rows: [{ id: "h1", name: "Nobody sees this" }] },
    });
    const { done, records } = run(
      {
        "/p/one": capture("/p/one", "Builtin Parent Child Posted Many", [
          list("/api/v1/sys", [{ id: "s1", name: "Builtin", isDefault: true }]),
          list("/api/v1/parent", [{ id: "p1", name: "Parent" }]),
          list("/api/v1/parent/{id}/child", [{ id: "c1", name: "Child" }]),
          list("/api/v1/posted", [{ id: "x1", name: "Posted" }], {
            method: "POST",
          }),
          list("/api/v1/many", many),
          list("/api/v1/hidden", [{ id: "h1", name: "Nobody sees this" }]),
        ]),
      },
      t.client,
    );
    const result = await done;
    expect(t.writes).toEqual([]);
    expect(result.failed).toBe(false);
    const outcomes = Object.fromEntries(
      found(records).map((r) => [r.route, r.detail?.outcome]),
    );
    expect(outcomes).toEqual({
      "/api/v1/parent": "related",
      "/api/v1/parent/{id}/child": "related",
      "/api/v1/posted": "post_list",
      "/api/v1/many": "over_cap",
      "/api/v1/hidden": "uncorrelated",
    });
    // The system only list is silent: no record at all.
    expect(records.some((r) => r.route === "/api/v1/sys")).toBe(false);
    expect(result.counts.discoverySkippedSystem).toBe(1);
  });

  it("leaves furniture, a denied list, a shared list, and a covered list alone, silently", async () => {
    const rows = [{ id: "a", name: "Thing" }];
    const t = table({});
    const shared = list("/api/v1/shared", rows);
    const pages = Object.fromEntries(
      ["/p/1", "/p/2", "/p/3"].map((p) => [
        p,
        capture(p, "Thing", [
          shared,
          ...(p === "/p/1"
            ? [
                list("/api/v1/featureflags", rows),
                list("/api/v1/users", rows),
                list("/api/v1/idps", rows),
                list("/api/v1/known", rows),
              ]
            : []),
        ]),
      ]),
    );
    const { done, records } = run(pages, t.client, {
      covered: ["/api/v1/known"],
    });
    await done;
    expect(t.writes).toEqual([]);
    expect(records).toEqual([]);
  });

  it("reports a route whose convention does not hold and fails the run, without a second try", async () => {
    const t = table({
      "/api/v1/gadgets": {
        rows: [{ id: "g1", name: "Lab gadget" }],
        deleteStatus: 405,
      },
    });
    const { done, records } = run(
      {
        "/p/one": capture("/p/one", "Lab gadget", [
          list("/api/v1/gadgets", [{ id: "g1", name: "Lab gadget" }]),
        ]),
      },
      t.client,
    );
    const result = await done;
    expect(result.failed).toBe(true);
    // One attempt (405 is a failure at once and not retried), no second pass.
    expect(t.writes).toHaveLength(1);
    expect(found(records)[0]?.detail).toMatchObject({
      deleted: 0,
      left: 1,
      outcome: "left",
    });
    expect(records.filter((r) => r.kind === "failed").length).toBeGreaterThan(
      0,
    );
  });

  it("in a dry run sends no write and records what it would delete", async () => {
    const t = table({
      "/api/v1/gadgets": { rows: [{ id: "g1", name: "Lab gadget" }] },
    });
    const { done, records } = run(
      {
        "/p/one": capture("/p/one", "Lab gadget", [
          list("/api/v1/gadgets", [{ id: "g1", name: "Lab gadget" }]),
        ]),
      },
      t.client,
      {},
      "dry_run",
    );
    const result = await done;
    expect(t.writes).toEqual([]);
    expect(result.failed).toBe(false);
    expect(records.some((r) => r.kind === "would_delete")).toBe(true);
    expect(found(records)[0]?.detail).toMatchObject({
      deleted: 0,
      outcome: "deletable",
    });
  });

  it("skips a page on the deny list and counts a page that timed out", async () => {
    const t = table({});
    const visited: string[] = [];
    const { done } = run(
      { "/network-setup/users": "timeout", "/p/slow": "timeout" },
      t.client,
      {
        collect: async (page) => {
          visited.push(page);
          return "timeout";
        },
      },
    );
    const result = await done;
    expect(visited).toEqual(["/p/slow"]);
    expect(result.counts).toMatchObject({
      discoveryPages: 0,
      discoveryTimedOut: 1,
    });
  });

  it("stops visiting pages when the time budget is spent, and caps the pages at 20", async () => {
    const t = table({});
    const visited: string[] = [];
    const pages = Array.from({ length: 30 }, (_v, i) => `/p/${i}`);
    let n = 0;
    const { done } = run({}, t.client, {
      pages,
      collect: async (page) => {
        visited.push(page);
        return capture(page, "", []);
      },
      // Over the budget after the third page.
      elapsedMs: () => (n++ >= 3 ? DISCOVERY_BUDGET : 0),
    });
    await done;
    expect(visited).toEqual(["/p/0", "/p/1", "/p/2"]);
    const all: string[] = [];
    await runDiscovery({
      collect: async (page) => {
        all.push(page);
        return capture(page, "", []);
      },
      env: {
        portal: t.client,
        mode: "live",
        pass: 1,
        sleep: async () => undefined,
        beforeWrite: async () => undefined,
        isGuarded: () => false,
        record: () => undefined,
        hidden: new Set(),
      },
      pages,
      covered: [],
      elapsedMs: () => 0,
    });
    expect(all).toHaveLength(20);
  });

  it("never deletes a guarded record found by convention", async () => {
    // A guarded id is refused by the shared interpreter before any send.
    const guarded = table({
      "/api/v1/gadgets": { rows: [{ id: "g1", name: "Lab gadget" }] },
    });
    const records: ItemRecord[] = [];
    await runDiscovery({
      collect: async () =>
        capture("/p/one", "Lab gadget", [
          list("/api/v1/gadgets", [{ id: "g1", name: "Lab gadget" }]),
        ]),
      env: {
        portal: guarded.client,
        mode: "live",
        pass: 1,
        sleep: async () => undefined,
        beforeWrite: async () => undefined,
        isGuarded: () => true,
        record: (r) => records.push(r),
        hidden: new Set(),
      },
      pages: ["/p/one"],
      covered: [],
      elapsedMs: () => 0,
    });
    expect(guarded.writes).toEqual([]);
    expect(records.some((r) => r.kind === "deleted")).toBe(false);
  });
});
