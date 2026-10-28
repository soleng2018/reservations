import { describe, expect, it } from "vitest";
import { routePattern } from "./route-pattern";

describe("routePattern", () => {
  it("replaces uuids, numbers, and tenant prefixed ids", () => {
    expect(
      routePattern(
        "/api/v1/settings/ssids/3f2b8c1e-aaaa-4bbb-8ccc-0123456789ab",
      ),
    ).toBe("/api/v1/settings/ssids/{id}");
    expect(routePattern("/api/v1/things/12345")).toBe("/api/v1/things/{id}");
    expect(routePattern("/api/v1/things/t1abc9z72")).toBe(
      "/api/v1/things/{id}",
    );
  });

  it("drops the query and keeps words and placeholders", () => {
    expect(routePattern("/api/v3/policy/policysets?size=2000")).toBe(
      "/api/v3/policy/policysets",
    );
    expect(routePattern("/api/v1/x/{id}/rules")).toBe("/api/v1/x/{id}/rules");
  });
});
