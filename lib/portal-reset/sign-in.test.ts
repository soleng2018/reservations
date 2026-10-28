import { describe, expect, it } from "vitest";
import { PortalResetSignInReason } from "@/lib/db-enums";
import { holdsRun, SIGN_IN_TEXT } from "./sign-in";

describe("holdsRun", () => {
  it("holds only for the two reasons a retry cannot fix", () => {
    expect(PortalResetSignInReason.options.filter((r) => holdsRun(r))).toEqual([
      "credential_failed",
      "idp_rejected",
    ]);
  });

  it("has words for every reason", () => {
    expect(Object.keys(SIGN_IN_TEXT).sort()).toEqual(
      [...PortalResetSignInReason.options].sort(),
    );
  });
});
