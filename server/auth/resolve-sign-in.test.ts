import { describe, expect, it } from "vitest";
import {
  refusalReason,
  resolveSignIn,
  signInClaimsSchema,
  type SignInRow,
} from "./resolve-sign-in";

const claims = (over: Partial<Record<string, unknown>> = {}) =>
  signInClaimsSchema.parse({
    sub: "17",
    email: "a@example.com",
    name: "A",
    groups: [],
    ...over,
  });
const admin = (over = {}) => claims({ groups: ["hol-admins"], ...over });
const row = (over: Partial<SignInRow> = {}): SignInRow => ({
  id: "u1",
  role: "learner",
  status: "active",
  hasBookings: false,
  ...over,
});

describe("resolveSignIn", () => {
  it("admits an hol-admins member, creating a row when none exists", () => {
    expect(resolveSignIn(admin(), undefined)).toEqual({
      kind: "admin",
      rowId: undefined,
    });
    expect(resolveSignIn(admin(), row({ role: "admin" }))).toEqual({
      kind: "admin",
      rowId: "u1",
    });
  });

  it("refuses an admin with no email claim", () => {
    expect(resolveSignIn(admin({ email: undefined }), undefined).kind).toBe(
      "refused_no_email",
    );
  });

  it("refuses a learner account that appears in hol-admins", () => {
    expect(resolveSignIn(admin(), row())).toEqual({
      kind: "refused_learner_is_admin",
      rowId: "u1",
    });
    expect(
      resolveSignIn(admin(), row({ role: "admin", hasBookings: true })).kind,
    ).toBe("refused_learner_is_admin");
  });

  it("admits a known active learner, and an ex admin as a learner", () => {
    expect(resolveSignIn(claims(), row())).toEqual({
      kind: "learner",
      rowId: "u1",
    });
    expect(resolveSignIn(claims(), row({ role: "admin" })).kind).toBe(
      "learner",
    );
  });

  it("refuses unknown and deactivated people", () => {
    expect(resolveSignIn(claims(), undefined).kind).toBe("refused_unknown");
    expect(resolveSignIn(claims(), row({ status: "deactivated" })).kind).toBe(
      "refused_deactivated",
    );
    expect(
      resolveSignIn(admin(), row({ role: "admin", status: "deactivated" }))
        .kind,
    ).toBe("refused_deactivated");
  });

  it("only treats the exact group name as admin", () => {
    expect(
      resolveSignIn(
        claims({ groups: ["hol-admins-x", "HOL-ADMINS"] }),
        undefined,
      ).kind,
    ).toBe("refused_unknown");
  });
});

describe("signInClaimsSchema", () => {
  it("requires a numeric sub (the Authentik user pk)", () => {
    expect(signInClaimsSchema.safeParse({ sub: "abc" }).success).toBe(false);
    expect(signInClaimsSchema.parse({ sub: "5" }).groups).toEqual([]);
  });
});

describe("refusalReason", () => {
  it("gives admin refusals no admin hint", () => {
    expect(refusalReason("refused_no_email")).toBe("not_authorized");
    expect(refusalReason("refused_learner_is_admin")).toBe("not_authorized");
    expect(refusalReason("refused_unknown")).toBe("unknown");
    expect(refusalReason("refused_deactivated")).toBe("deactivated");
  });
});
