import { describe, expect, it } from "vitest";
import { BLOCKED_COPY, confirmMessage } from "./delete-flow";

describe("delete flow copy", () => {
  it("names the item in the confirm message", () => {
    expect(confirmMessage("Basic")).toBe(
      `Delete "Basic"? This can't be undone.`,
    );
  });

  it("has the mock's blocked copy for each kind", () => {
    expect(BLOCKED_COPY.testbed_type.title).toBe("Testbed type in use");
    expect(BLOCKED_COPY.testbed_type.message("Basic")).toBe(
      `"Basic" is assigned to the testbeds below. Reassign or delete them first.`,
    );
    expect(BLOCKED_COPY.api_key.message("Okta")).toBe(
      `"Okta" is assigned to the testbeds below. Remove it from them first.`,
    );
    expect(BLOCKED_COPY.testbed.title).toBe("Testbed has active reservations");
    expect(BLOCKED_COPY.testbed.message("Bench 1")).toBe(
      `"Bench 1" has upcoming or current reservations below. Resolve them first.`,
    );
  });
});
