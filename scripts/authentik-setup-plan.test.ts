import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CALLBACK_PATH,
  cloudflareLoginSettings,
  LAB_AUTHORIZATION_FLOW_SLUG,
  LABS_PROVIDER_NAME,
  PROVISIONING_PERMISSIONS,
  desiredHolAuthorizationFlow,
  desiredLabAuthorizationFlow,
  desiredLabsProvider,
  desiredProvider,
  diffFields,
  holFlowProblems,
  isolationExpression,
  isolationFlowProblems,
  labsAccessExpression,
  labsAppProblems,
  parseAppUrls,
  parseTeamDomain,
  planPermissions,
  uncoveredProviders,
  desiredRecoveryLoginStage,
  RECOVERY_STAGE_ORDER,
  authorizeProbeProblem,
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
      {
        matching_mode: "strict",
        url: `https://hol.example${CALLBACK_PATH}`,
        redirect_uri_type: "authorization",
      },
      {
        matching_mode: "regex",
        url: "^http:\\/\\/localhost:3000\\/api\\/auth\\/callback\\/authentik$",
        redirect_uri_type: "authorization",
      },
    ]);
  });

  it("allows the authorization code and refresh grants (an empty list fails every sign in)", () => {
    expect(p.grant_types).toEqual(["authorization_code", "refresh_token"]);
  });

  it("makes the http regex match only its own callback", () => {
    const re = new RegExp(p.redirect_uris[1]?.url ?? "");
    expect(re.test(`http://localhost:3000${CALLBACK_PATH}`)).toBe(true);
    expect(re.test(`http://localhost:3000${CALLBACK_PATH}/x`)).toBe(false);
    expect(re.test(`http://localhostX3000${CALLBACK_PATH}`)).toBe(false);
  });
});

// covers: spec 0003 AC-19 (HOL Labs, spec 0012 AC-9)
describe("HOL Labs", () => {
  it("parses the Cloudflare team domain as a bare host", () => {
    expect(parseTeamDomain(" Soleng2018.CloudflareAccess.com ")).toEqual({
      ok: true,
      domain: "soleng2018.cloudflareaccess.com",
    });
    for (const bad of [
      undefined,
      "",
      "https://soleng2018.cloudflareaccess.com",
      "soleng2018.cloudflareaccess.com/cdn-cgi",
      "evil.example",
      "soleng2018.cloudflareaccess.com.evil.example",
    ])
      expect(parseTeamDomain(bad).ok).toBe(false);
  });

  it("lists every Cloudflare login field, with the secret kept out", () => {
    const text = cloudflareLoginSettings(
      "https://authentik.example",
      "team.cloudflareaccess.com",
      "client-id-1",
      "the contents of /tmp/secret-file",
    ).join("\n");
    expect(text).toContain(
      "https://team.cloudflareaccess.com/cdn-cgi/access/callback",
    );
    expect(text).toContain("App ID:           client-id-1");
    expect(text).toContain(
      "https://authentik.example/application/o/authorize/",
    );
    expect(text).toContain("https://authentik.example/application/o/token/");
    expect(text).toContain(
      "https://authentik.example/application/o/hol-labs/jwks/",
    );
    expect(text).toContain("PKCE:             On");
    expect(text).toContain("add groups");
    expect(text).toContain("the contents of /tmp/secret-file");
  });

  it("gives HOL Labs its own empty authorization flow, like HOL's", () => {
    expect(desiredLabAuthorizationFlow).toEqual({
      ...desiredHolAuthorizationFlow,
      name: "HOL lab authorization",
      slug: LAB_AUTHORIZATION_FLOW_SLUG,
    });
    expect(
      holFlowProblems(
        { designation: "authorization", policyBindings: 1, stageBindings: 0 },
        LAB_AUTHORIZATION_FLOW_SLUG,
      ),
    ).toEqual([`${LAB_AUTHORIZATION_FLOW_SLUG}: has 1 policy binding(s)`]);
  });

  it("wants one strict Cloudflare callback, a hashed sub, and the groups scope", () => {
    const p = desiredLabsProvider({
      teamDomain: "team.cloudflareaccess.com",
      authorizationFlow: "lab-auth",
      invalidationFlow: "inv",
      signingKey: "key",
      scopeMappings: ["profile", "openid", "email"],
    });
    expect(p).toMatchObject({
      name: LABS_PROVIDER_NAME,
      client_type: "confidential",
      grant_types: ["authorization_code", "refresh_token"],
      sub_mode: "hashed_user_id",
      issuer_mode: "per_provider",
      authorization_flow: "lab-auth",
      property_mappings: ["email", "openid", "profile"],
      redirect_uris: [
        {
          matching_mode: "strict",
          url: "https://team.cloudflareaccess.com/cdn-cgi/access/callback",
          redirect_uri_type: "authorization",
        },
      ],
    });
  });

  // covers: spec 0017 AC-12
  it("passes staff, and a learner only while in a group marked for testbeds", () => {
    const text = labsAccessExpression();
    expect(text).toContain('path == "hol/learners"');
    expect(text).toContain('path.startswith("hol/learners/")');
    expect(text).toContain(
      "return request.user.groups.filter(attributes__hol_testbed_group=True).exists()",
    );
    // The marker, not a name prefix: no `pod-` anywhere in the policy.
    expect(text).not.toContain("pod-");
    // Like isolation, its code never reads the app or the VM being opened.
    const code = text
      .split("\n")
      .filter((l) => !l.startsWith("#"))
      .join("\n");
    expect(code).not.toMatch(/context|application|slug/);
  });

  it("refuses an app with any binding but hol-labs-access", () => {
    expect(labsAppProblems([], "p1")).toEqual([]);
    expect(labsAppProblems([{ policy: "p1" }], "p1")).toEqual([]);
    expect(
      labsAppProblems([{ policy: "p1" }, { policy: null }], "p1"),
    ).toHaveLength(1);
    expect(labsAppProblems([{ policy: "p1" }], undefined)).toHaveLength(1);
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

// covers: spec 0014 AC-11
describe("hol-recovery stages (spec 0014 AC-11)", () => {
  it("signs the learner in after the password, with a browser session", () => {
    expect(desiredRecoveryLoginStage).toEqual({
      name: "hol-recovery-login",
      session_duration: "seconds=0",
    });
    expect(RECOVERY_STAGE_ORDER).toEqual({ prompt: 10, write: 20, login: 30 });
  });
});

// covers: spec 0017 AC-12 (the plan's own text no longer speaks of pod- groups)
describe("no pod- left in the setup plan (spec 0017 AC-12)", () => {
  it("names no pod- group in the policy, the permission comment, or the plan", () => {
    const source = readFileSync(
      path.resolve(__dirname, "authentik-setup-plan.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/pod-/);
  });
});

describe("authorizeProbeProblem", () => {
  it("accepts a redirect to a login flow", () => {
    expect(
      authorizeProbeProblem(302, "/if/flow/default-authentication-flow/?x=1"),
    ).toBeUndefined();
  });

  it("reports the error Authentik sends back to the callback", () => {
    expect(
      authorizeProbeProblem(
        302,
        `https://hol.example${CALLBACK_PATH}?error=invalid_request&error_description=The%20request%20is%20otherwise%20malformed&state=x`,
      ),
    ).toBe(
      "Authentik refused the request: invalid_request (The request is otherwise malformed)",
    );
  });

  it("reports a response that is not a redirect", () => {
    expect(authorizeProbeProblem(500, null)).toMatch(/500/);
    expect(authorizeProbeProblem(200, null)).toMatch(/200/);
  });
});
