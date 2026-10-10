import { describe, expect, it } from "vitest";
import {
  CALLBACK_PATH,
  PROVISIONING_PERMISSIONS,
  desiredProvider,
  diffFields,
  holFlowProblems,
  isolationExpression,
  isolationFlowProblems,
  parseAppUrls,
  planPermissions,
  uncoveredProviders,
} from "./authentik-setup-plan";

describe("isolationExpression (AC-17)", () => {
  const text = isolationExpression();

  it("denies the learner path and everything under it", () => {
    expect(text).toContain('path == "hol/learners"');
    expect(text).toContain('path.startswith("hol/learners/")');
    expect(text.split("\n").at(-1)).toMatch(/^return not \(/);
  });

  // A pass cached for one app would carry to the next (the failed spike).
  it("never reads the app being opened, so a cached result is always right", () => {
    expect(text).not.toMatch(/context|application|slug/);
  });
});

describe("holFlowProblems (AC-17)", () => {
  it("accepts an empty authorization flow", () => {
    expect(
      holFlowProblems({
        designation: "authorization",
        policyBindings: 0,
        stageBindings: 0,
      }),
    ).toEqual([]);
  });

  it("refuses another designation or anything bound to it", () => {
    expect(
      holFlowProblems({
        designation: "invalidation",
        policyBindings: 1,
        stageBindings: 2,
      }),
    ).toHaveLength(3);
  });
});

describe("isolationFlowProblems (AC-17)", () => {
  const ok = {
    slug: "f",
    policy_engine_mode: "any",
    denied_action: "message_continue",
    bindings: [],
  };

  it("accepts a clean flow, with or without our binding", () => {
    expect(isolationFlowProblems(ok, "p1")).toEqual([]);
    expect(
      isolationFlowProblems({ ...ok, bindings: [{ policy: "p1" }] }, "p1"),
    ).toEqual([]);
  });

  it("refuses another binding, a non any mode, or a changed denied action", () => {
    expect(
      isolationFlowProblems(
        {
          slug: "f",
          policy_engine_mode: "all",
          denied_action: "continue",
          bindings: [{ policy: "other" }],
        },
        "p1",
      ),
    ).toHaveLength(3);
  });

  it("treats every binding as foreign before our policy exists", () => {
    expect(
      isolationFlowProblems({ ...ok, bindings: [{ policy: "p1" }] }, undefined),
    ).toHaveLength(1);
  });
});

describe("uncoveredProviders (AC-13)", () => {
  it("lists providers on a flow that is not covered", () => {
    expect(
      uncoveredProviders(
        [
          { name: "a", authorization_flow: "f1" },
          { name: "b", authorization_flow: "f9" },
        ],
        ["f1", "f2"],
      ),
    ).toEqual([{ name: "b", authorization_flow: "f9" }]);
  });
});

describe("parseAppUrls", () => {
  it("keeps sorted, unique origins", () => {
    expect(
      parseAppUrls(
        " https://hol.example/ ,http://localhost:3000,https://hol.example",
      ),
    ).toEqual({
      ok: true,
      urls: ["http://localhost:3000", "https://hol.example"],
    });
  });

  it("refuses paths, other schemes, and junk", () => {
    expect(parseAppUrls("https://hol.example/app").ok).toBe(false);
    expect(parseAppUrls("ftp://hol.example").ok).toBe(false);
    expect(parseAppUrls("not a url").ok).toBe(false);
    expect(parseAppUrls(" , ").ok).toBe(false);
  });
});

describe("desiredProvider", () => {
  const p = desiredProvider({
    appUrls: ["https://hol.example", "http://localhost:3000"],
    authorizationFlow: "hol-auth",
    invalidationFlow: "inv",
    signingKey: "key",
    scopeMappings: ["profile", "openid", "email"],
  });

  // covers: AC-12, AC-17
  it("uses the user pk as sub, HOL's own flow, and only a callback per URL", () => {
    expect(p.sub_mode).toBe("user_id");
    expect(p.authorization_flow).toBe("hol-auth");
    expect(p.redirect_uris).toEqual([
      { matching_mode: "strict", url: `https://hol.example${CALLBACK_PATH}` },
      {
        matching_mode: "regex",
        url: "^http:\\/\\/localhost:3000\\/api\\/auth\\/callback\\/authentik$",
      },
    ]);
  });

  it("makes the http regex match only its own callback", () => {
    const re = new RegExp(p.redirect_uris[1]?.url ?? "");
    expect(re.test(`http://localhost:3000${CALLBACK_PATH}`)).toBe(true);
    expect(re.test(`http://localhost:3000${CALLBACK_PATH}/x`)).toBe(false);
    expect(re.test(`http://localhostX3000${CALLBACK_PATH}`)).toBe(false);
  });
});

describe("diffFields", () => {
  it("ignores order in arrays and fields it does not manage", () => {
    expect(
      diffFields(
        { a: ["x", "y"], b: [{ u: 1, m: "s" }], other: 9 },
        { a: ["y", "x"], b: [{ m: "s", u: 1 }] },
      ),
    ).toEqual([]);
  });

  it("reports changed and missing fields", () => {
    expect(diffFields({ a: 1 }, { a: 2, b: null })).toEqual([
      { field: "a", from: 1, to: 2 },
      { field: "b", from: undefined, to: null },
    ]);
  });
});

describe("planPermissions", () => {
  it("adds what is missing and removes extras", () => {
    expect(
      planPermissions([
        "authentik_core.view_user",
        "authentik_core.change_group",
      ]),
    ).toEqual({
      add: PROVISIONING_PERMISSIONS.filter(
        (p) => p !== "authentik_core.view_user",
      ),
      remove: ["authentik_core.change_group"],
    });
  });

  it("never grants anything outside users, groups, and sessions", () => {
    expect(
      PROVISIONING_PERMISSIONS.every((p) =>
        /^authentik_core\.\w+_(user|group|user_to_group|user_from_group|authenticatedsession|user_password)$/.test(
          p,
        ),
      ),
    ).toBe(true);
  });
});
