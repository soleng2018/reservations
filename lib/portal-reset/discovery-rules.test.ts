import { describe, expect, it } from "vitest";
import {
  outcomeOf,
  conventionPath,
  conventionRoute,
  coveredRoutes,
  correlates,
  discoveryConfig,
  dropReason,
  isCovered,
  isRelated,
  isSystemRecord,
  labelOf,
  listRecords,
  type Candidate,
} from "./discovery-rules";
import { StepDefinition } from "./step-schema";

const cand = (over: Partial<Candidate> = {}): Candidate => ({
  method: "GET",
  route: "/api/v1/things",
  path: "/api/v1/things",
  page: "/network-setup/things",
  itemsAt: "$",
  records: [{ id: "a1", name: "Lab thing" }],
  ...over,
});

describe("listRecords", () => {
  it.each([
    ["root", [{ id: "1" }]],
    ["content", { content: [{ id: "1" }] }],
    ["data", { data: [{ id: "1" }] }],
    ["data.content", { data: { content: [{ id: "1" }] } }],
  ])("finds records at the %s shape", (_n, body) => {
    expect(listRecords(body)).toEqual([{ id: "1" }]);
  });

  it.each([
    ["an empty list", []],
    ["records without an id", [{ name: "x" }]],
    ["a mix", [{ id: "1" }, "x"]],
    ["an object", { id: "1" }],
    ["nothing", null],
  ])("gives null for %s", (_n, body) => {
    expect(listRecords(body)).toBeNull();
  });

  it("accepts numeric ids", () => {
    expect(listRecords([{ id: 5 }])).toEqual([{ id: 5 }]);
  });
});

describe("dropReason", () => {
  it("keeps an ordinary new list", () => {
    expect(dropReason(cand(), 1, [])).toBeNull();
  });

  it("drops furniture", () => {
    expect(
      dropReason(
        cand({ route: "/api/v1/featureflags", path: "/api/v1/featureflags" }),
        1,
        [],
      ),
    ).toBe("furniture");
  });

  it("drops a denied route silently, ahead of everything", () => {
    expect(
      dropReason(
        cand({ route: "/api/v1/users", path: "/api/v1/users" }),
        1,
        [],
      ),
    ).toBe("denied");
    expect(
      dropReason(cand({ route: "/api/v1/idps", path: "/api/v1/idps" }), 1, []),
    ).toBe("denied");
  });

  it("drops a list seen on the threshold number of pages or more", () => {
    const n = discoveryConfig.sharedThreshold;
    expect(dropReason(cand(), n - 1, [])).toBeNull();
    expect(dropReason(cand(), n, [])).toBe("shared");
  });

  it("drops a route a step covers, and one under a step's delete route", () => {
    expect(dropReason(cand(), 1, ["/api/v1/things"])).toBe("covered");
    expect(
      dropReason(cand({ route: "/api/v1/things/{id}/parts" }), 1, [
        "/api/v1/things",
      ]),
    ).toBe("covered");
    expect(
      dropReason(cand({ route: "/api/v1/thingsx" }), 1, ["/api/v1/things"]),
    ).toBeNull();
  });
});

describe("related routes", () => {
  it("is a segment prefix either way, never an equal or a look alike", () => {
    expect(isRelated("/api/v1/a", "/api/v1/a/{id}/b")).toBe(true);
    expect(isRelated("/api/v1/a/{id}/b", "/api/v1/a")).toBe(true);
    expect(isRelated("/api/v1/a", "/api/v1/a")).toBe(false);
    expect(isRelated("/api/v1/a", "/api/v1/ab")).toBe(false);
  });

  it("isCovered is a prefix test by whole segments", () => {
    expect(isCovered("/api/v1/a/b", ["/api/v1/a"])).toBe(true);
    expect(isCovered("/api/v1/ab", ["/api/v1/a"])).toBe(false);
  });
});

describe("outcomeOf", () => {
  const text = "Lab thing is listed here";

  it("is deletable for a short, shown, non system GET list", () => {
    expect(outcomeOf(cand(), text, [])).toBe("deletable");
  });

  it("reports a related route and does not delete it", () => {
    expect(outcomeOf(cand(), text, ["/api/v1/things/{id}/parts"])).toBe(
      "related",
    );
  });

  it("reports a POST list and does not delete it", () => {
    expect(outcomeOf(cand({ method: "POST" }), text, [])).toBe("post_list");
  });

  it("reports a list over the cap", () => {
    const many = Array.from(
      { length: discoveryConfig.maxItemsPerRoute + 1 },
      (_v, i) => ({
        id: String(i),
        name: "Lab thing",
      }),
    );
    expect(outcomeOf(cand({ records: many }), text, [])).toBe("over_cap");
  });

  it("reports a list no label of which shows on the page", () => {
    expect(outcomeOf(cand(), "something else entirely", [])).toBe(
      "uncorrelated",
    );
  });

  it("reports a list of only system records", () => {
    expect(
      outcomeOf(
        cand({ records: [{ id: "1", name: "Lab thing", isDefault: true }] }),
        text,
        [],
      ),
    ).toBe("system_only");
  });
});

describe("helpers", () => {
  it("labelOf takes the first usable label field, at least 2 characters", () => {
    expect(labelOf({ name: "x", title: "Real title" })).toBe("Real title");
    expect(labelOf({ id: "1" })).toBeNull();
  });

  it("correlates matches case insensitively", () => {
    expect(correlates([{ id: "1", name: "Lab Thing" }], "the lab thing")).toBe(
      true,
    );
    expect(correlates([{ id: "1", name: "Lab Thing" }], "nothing")).toBe(false);
  });

  it("isSystemRecord reads the flag fields, true only", () => {
    expect(isSystemRecord({ isDefault: true })).toBe(true);
    expect(isSystemRecord({ isDefault: "true" })).toBe(false);
    expect(isSystemRecord({ ssid: { popTunnelUsed: true } })).toBe(false);
  });

  it("builds the delete route by convention and encodes the id", () => {
    expect(conventionPath(cand(), "a/b")).toBe("/api/v1/things/a%2Fb");
    expect(conventionRoute(cand())).toBe("/api/v1/things/{id}");
  });
});

describe("coveredRoutes", () => {
  it("collects every route of every part as a pattern without placeholders or query", () => {
    const def = StepDefinition.parse({
      parts: [
        {
          kind: "delete_each",
          list: {
            method: "GET",
            path: "/api/v1/things?size=2000",
            itemsAt: "data.content",
            idField: "id",
          },
          delete: { path: "/api/v1/things/{id}" },
        },
        { kind: "call", method: "DELETE", path: "/api/v1/other" },
      ],
    });
    expect(coveredRoutes([def])).toEqual([
      "/api/v1/things",
      "/api/v1/things/{id}",
      "/api/v1/other",
    ]);
  });
});
