import { describe, expect, it } from "vitest";
import {
  CALLBACK_PATH,
  PROVISIONING_PERMISSIONS,
  desiredProvider,
  diffFields,
  parseAppUrls,
  planPermissions,
} from "./authentik-setup-plan";

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
    authorizationFlow: "auth",
    invalidationFlow: "inv",
    signingKey: "key",
    scopeMappings: ["profile", "openid", "email"],
  });

  it("uses the user pk as sub and one callback per URL", () => {
    expect(p.sub_mode).toBe("user_id");
    expect(p.redirect_uris).toEqual([
      { matching_mode: "strict", url: `https://hol.example${CALLBACK_PATH}` },
      {
        matching_mode: "regex",
        url: "^http:\\/\\/localhost:3000\\/api\\/auth\\/oauth2\\/callback\\/authentik$",
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
