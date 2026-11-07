import { describe, expect, it } from "vitest";
import {
  computeProtected,
  guardedPortal,
  isGuardedWrite,
  NO_PROTECTION,
} from "./guards";
import { guards as allGuards } from "@/lib/portal-reset/guards";
import { GuardStop } from "./stop";
import {
  baselineState,
  makeFake,
  populatedState,
  SIGNED_IN_USER,
} from "./testing";

const noSleep = async () => undefined;

async function protectedFor(fake = makeFake()) {
  const found = await computeProtected(fake.portal, noSleep);
  if (!found.ok) throw new Error(`guard setup failed: ${found.error.why}`);
  return { fake, prot: found.value };
}

// covers: AC-25, AC-26, AC-27
describe("computeProtected", () => {
  it("keeps exactly the records the guard file says, never by name", async () => {
    const { prot } = await protectedFor();
    const ids = prot.flatMap((p) => [...p.ids]);
    expect(ids).toContain("ssid-protected");
    // The look alike named like the protected one, and a guest SSID, survive
    // the guard: only the flag decides (AC-27).
    expect(ids).not.toContain("ssid-lookalike");
    expect(ids).not.toContain("ssid-guest");
    expect(ids).toContain("rad-nile");
    expect(ids).not.toContain("rad1");
  });

  it("stops when two records carry the protected flag", async () => {
    const state = populatedState();
    state.ssids = [
      ...state.ssids,
      { id: "ssid-second", ssid: { popTunnelUsed: true } },
    ];
    const found = await computeProtected(makeFake(state).portal, noSleep);
    expect(found).toEqual({
      ok: false,
      error: { guardKey: "protected-ssid", why: "expect_kept" },
    });
  });

  it("stops when none carries it while the list is not empty", async () => {
    const state = populatedState();
    state.ssids = state.ssids.map((s) => ({
      ...s,
      ssid: { popTunnelUsed: false },
    }));
    const found = await computeProtected(makeFake(state).portal, noSleep);
    expect(found.ok).toBe(false);
  });

  it("accepts an empty list and a list that is not there", async () => {
    const state = baselineState();
    state.ssids = [];
    const fake = makeFake(state);
    const real = fake.intercept;
    fake.intercept = (req) =>
      req.path.startsWith("/api/v1/cloudradius/policysets")
        ? { status: 404, body: {} }
        : real(req);
    expect((await computeProtected(fake.portal, noSleep)).ok).toBe(true);
  });

  it("fails closed on a list that is not there when the guard expects a kept record (spec 0027 AC-6)", async () => {
    const fake = makeFake(baselineState());
    const real = fake.intercept;
    fake.intercept = (req) =>
      req.path.startsWith("/api/v1/settings/radius")
        ? { status: 404, body: {} }
        : real(req);
    expect(await computeProtected(fake.portal, noSleep)).toEqual({
      ok: false,
      error: { guardKey: "nile-radius", why: "unreadable" },
    });
  });

  it("fails closed on a list that is not there, for a guard read because a step needs it", async () => {
    const fake = makeFake(baselineState());
    fake.intercept = (req) =>
      req.path.startsWith("/api/v2/users")
        ? { status: 404, body: {} }
        : undefined;
    expect(
      await computeProtected(
        fake.portal,
        noSleep,
        allGuards.filter((g) => g.key === "users-root-admin"),
        SIGNED_IN_USER,
      ),
    ).toEqual({
      ok: false,
      error: { guardKey: "users-root-admin", why: "unreadable" },
    });
  });

  it("fails closed when a list cannot be read, after the retries", async () => {
    const fake = makeFake();
    fake.intercept = () => ({ status: 500, body: {} });
    const sleeps: number[] = [];
    const found = await computeProtected(fake.portal, async (ms) => {
      sleeps.push(ms);
    });
    expect(found).toEqual({
      ok: false,
      error: { guardKey: "protected-ssid", why: "unreadable" },
    });
    expect(sleeps).toEqual([2000, 6000]);
  });
});

describe("guardedPortal", () => {
  it("refuses a delete of a protected id wherever a step reached it, sending nothing", async () => {
    const { fake, prot } = await protectedFor();
    const portal = guardedPortal(fake.portal, prot);
    await expect(
      portal.call({
        method: "DELETE",
        path: "/api/v1/settings/ssids/ssid-protected",
      }),
    ).rejects.toBeInstanceOf(GuardStop);
    await expect(
      portal.call({
        method: "DELETE",
        path: "/api/v1/settings/ssids",
        body: { ids: ["ssid-guest", "SSID-PROTECTED"] },
      }),
    ).rejects.toBeInstanceOf(GuardStop);
    expect(fake.writes).toHaveLength(0);
  });

  it("refuses a write that names a protected id in the query string", async () => {
    const { fake, prot } = await protectedFor();
    const portal = guardedPortal(fake.portal, prot);
    for (const method of ["DELETE", "PUT"] as const) {
      await expect(
        portal.call({
          method,
          path: "/api/v1/settings/ssids?id=SSID-PROTECTED",
        }),
      ).rejects.toBeInstanceOf(GuardStop);
    }
    await expect(
      portal.call({
        method: "DELETE",
        path: "/api/v1/settings/ssids?ids=ssid-guest,ssid-protected",
      }),
    ).rejects.toBeInstanceOf(GuardStop);
    expect(fake.writes).toHaveLength(0);
    expect(
      isGuardedWrite(prot)(
        "DELETE",
        "/api/v1/settings/ssids?id=ssid-protected",
        [],
      ),
    ).toBe(true);
  });

  it("lets a delete of an unprotected record through", async () => {
    const { fake, prot } = await protectedFor();
    const sent = await guardedPortal(fake.portal, prot).call({
      method: "DELETE",
      path: "/api/v1/settings/ssids/ssid-lookalike",
    });
    expect(sent.ok).toBe(true);
    expect(fake.writes).toHaveLength(1);
  });

  it("lets a custom policy go in the set that holds a system policy, and keeps the set", async () => {
    // Workshop 4, 2026-10-29: the custom policy sits in the same set as the
    // system policies. Its delete route and body carry the set id.
    const { fake, prot } = await protectedFor();
    const guarded = isGuardedWrite(prot);
    expect(
      guarded("DELETE", "/api/v3/policy/policysets/ps1/rules/pol1", ["pol1"]),
    ).toBe(false);
    expect(
      guarded("DELETE", "/api/v3/policy/policysets/ps1/rules/pol-sys", [
        "pol-sys",
      ]),
    ).toBe(true);
    expect(guarded("DELETE", "/api/v3/policy/policysets/ps1", ["ps1"])).toBe(
      true,
    );
    const sent = await guardedPortal(fake.portal, prot).call({
      method: "DELETE",
      path: "/api/v3/policy/policysets/ps1/rules/pol1",
      body: { id: "pol1", policySetId: "ps1" },
    });
    expect(sent.ok).toBe(true);
    const stop = await guardedPortal(fake.portal, prot)
      .call({ method: "DELETE", path: "/api/v3/policy/policysets/ps1" })
      .catch((e: unknown) => e);
    expect(stop).toBeInstanceOf(GuardStop);
  });

  it("lets a step change Nile DHCP and the Default Network Policy, never delete them", async () => {
    // A PUT is how a step empties the Nile DHCP scopes and sets the default
    // policy to REJECT; the guards say never deleted (2026-10-29: both steps
    // were skipped on Workshop 4 because a PUT was guarded too).
    const { fake, prot } = await protectedFor();
    const guarded = isGuardedWrite(prot);
    expect(
      guarded("PUT", "/api/v1/settings/dhcp-clients/dh-nile", ["dh-nile"]),
    ).toBe(false);
    expect(
      guarded("DELETE", "/api/v1/settings/dhcp-clients/dh-nile", ["dh-nile"]),
    ).toBe(true);
    expect(
      guarded(
        "PUT",
        "/api/v1/cloudradius/policysets/nps1/policies/np-default",
        ["np-default"],
      ),
    ).toBe(false);
    expect(
      guarded(
        "DELETE",
        "/api/v1/cloudradius/policysets/nps1/policies/np-default",
        ["np-default"],
      ),
    ).toBe(true);
    // a protected SSID still cannot be written with a PUT
    expect(
      guarded("PUT", "/api/v1/settings/ssids/ssid-protected", [
        "ssid-protected",
      ]),
    ).toBe(true);
    const put = await guardedPortal(fake.portal, prot).call({
      method: "PUT",
      path: "/api/v1/settings/dhcp-clients/dh-nile",
      body: {
        id: "dh-nile",
        dhcpClient: { cloudDHCP: true, servers: [{ subnets: [] }] },
      },
    });
    expect(put.ok).toBe(true);
  });

  it("never calls a denied path, of any method, and names a route pattern only", async () => {
    const fake = makeFake();
    const portal = guardedPortal(fake.portal, NO_PROTECTION);
    for (const method of ["GET", "POST", "PUT", "DELETE"] as const) {
      const stop = await portal
        .call({
          method,
          path: "/api/v1/idps/3f2b8c1e-aaaa-4bbb-8ccc-0123456789ab",
        })
        .catch((e: unknown) => e);
      expect(stop).toBeInstanceOf(GuardStop);
      expect((stop as GuardStop).route).toBe("/api/v1/idps/{id}");
    }
    expect(fake.calls).toHaveLength(0);
  });

  it("refuses a denied path that is dressed up", async () => {
    const portal = guardedPortal(makeFake().portal, NO_PROTECTION);
    for (const path of [
      "/api/v1/IDPS",
      "/api/v1/settings/../idps",
      "/api/v1//idps/x",
      "/api/v1/%69dps",
    ]) {
      await expect(portal.call({ method: "GET", path })).rejects.toBeInstanceOf(
        GuardStop,
      );
    }
  });
});

describe("isGuardedWrite", () => {
  it("is true for a protected id in the path or a batch, false for a read or another route", async () => {
    const { prot } = await protectedFor();
    const guarded = isGuardedWrite(prot);
    expect(guarded("DELETE", "/api/v1/settings/ssids/ssid-protected", [])).toBe(
      true,
    );
    expect(
      guarded("DELETE", "/api/v1/settings/ssids", ["ssid-protected"]),
    ).toBe(true);
    expect(guarded("DELETE", "/api/v1/settings/ssids/ssid-guest", [])).toBe(
      false,
    );
    expect(guarded("DELETE", "/api/v1/other/ssid-protected", [])).toBe(false);
  });

  it("protects a system policy and the set that holds it", async () => {
    const { prot } = await protectedFor(makeFake(baselineState()));
    const guarded = isGuardedWrite(prot);
    expect(
      guarded("DELETE", "/api/v3/policy/policysets/ps1/rules/pol-sys", []),
    ).toBe(true);
    expect(guarded("DELETE", "/api/v3/policy/policysets/ps1", [])).toBe(true);
  });
});

// covers: spec 0027 AC-5 to AC-10
describe("the Users guards", () => {
  const usersGuards = allGuards.filter((g) => g.key.startsWith("users-"));
  const load = (fake = makeFake(), id: string | null = SIGNED_IN_USER) =>
    computeProtected(fake.portal, noSleep, usersGuards, id ?? undefined);

  it("keeps the RootAdmin by group, wherever the group sits, and the signed in user by id", async () => {
    const found = await load();
    if (!found.ok) throw new Error(found.error.why);
    expect(found.value.flatMap((p) => [...p.ids]).sort()).toEqual([
      "u-automation",
      "u-root",
    ]);
  });

  it("stops before any write when no user holds the RootAdmin group", async () => {
    const state = populatedState();
    state.users = state.users.map((u) => ({ ...u, groupIds: [] }));
    expect(await load(makeFake(state))).toEqual({
      ok: false,
      error: { guardKey: "users-root-admin", why: "expect_kept" },
    });
  });

  it("stops when the signed in user is not listed once, or its id is unknown", async () => {
    const state = populatedState();
    state.users = state.users.filter((u) => u.id !== SIGNED_IN_USER);
    expect(await load(makeFake(state))).toEqual({
      ok: false,
      error: { guardKey: "users-signed-in", why: "expect_kept" },
    });
    expect(await load(makeFake(), null)).toEqual({
      ok: false,
      error: { guardKey: "users-signed-in", why: "expect_kept" },
    });
  });

  it("stops when the tenant has more users than the page returned", async () => {
    const fake = makeFake();
    fake.intercept = (req) =>
      req.path.startsWith("/api/v2/users")
        ? {
            status: 200,
            body: { content: fake.state.users, totalElements: 2001 },
          }
        : undefined;
    expect(await load(fake)).toEqual({
      ok: false,
      error: { guardKey: "users-root-admin", why: "bad_shape" },
    });
  });

  it("refuses a deactivate or a delete that holds a kept id, in the path or the body", async () => {
    const fake = makeFake();
    const found = await load(fake);
    if (!found.ok) throw new Error(found.error.why);
    const portal = guardedPortal(fake.portal, found.value);
    const refused = [
      { method: "POST", path: "/api/v1/users/u-root/lifecycle/deactivate" },
      {
        method: "POST",
        path: "/api/v1/users/u-learner1/lifecycle/deactivate",
        body: { id: SIGNED_IN_USER },
      },
      { method: "DELETE", path: `/api/v1/users/${SIGNED_IN_USER}` },
      { method: "DELETE", path: "/api/v1/users/U-ROOT" },
    ] as const;
    for (const req of refused) {
      await expect(portal.call(req)).rejects.toBeInstanceOf(GuardStop);
    }
    expect(fake.writes).toEqual([]);
    const ok = await portal.call({
      method: "POST",
      path: "/api/v1/users/u-learner1/lifecycle/deactivate",
      body: { id: "u-learner1" },
    });
    expect(ok).toMatchObject({ ok: true, value: { status: 204 } });
  });

  it("is protected in the skip check for a POST too", async () => {
    const found = await load();
    if (!found.ok) throw new Error(found.error.why);
    const guarded = isGuardedWrite(found.value);
    expect(
      guarded("POST", "/api/v1/users/u-root/lifecycle/deactivate", ["u-root"]),
    ).toBe(true);
    expect(
      guarded("POST", "/api/v1/users/u-x/lifecycle/deactivate", ["u-x"]),
    ).toBe(false);
    // Other guards do not guard a POST.
    expect(guarded("POST", "/api/v1/settings/ssids/ssid-protected", [])).toBe(
      false,
    );
  });

  it("refuses a write the allow list lets through when its guards were not loaded, and any other Users route", async () => {
    const fake = makeFake();
    const none = guardedPortal(fake.portal, NO_PROTECTION);
    await expect(
      none.call({ method: "DELETE", path: "/api/v1/users/u-learner1" }),
    ).rejects.toBeInstanceOf(GuardStop);
    await expect(
      none.call({
        method: "POST",
        path: "/api/v1/users/u-learner1/lifecycle/deactivate",
      }),
    ).rejects.toBeInstanceOf(GuardStop);
    // The guard's own list read is how they load: a GET passes.
    expect(
      await none.call({
        method: "GET",
        path: "/api/v2/users?page=0&size=2000",
      }),
    ).toMatchObject({ ok: true });
    const found = await load(fake);
    if (!found.ok) throw new Error(found.error.why);
    const guarded = guardedPortal(fake.portal, found.value);
    for (const req of [
      { method: "POST", path: "/api/v1/users" },
      { method: "PUT", path: "/api/v1/users/u-learner1" },
      { method: "POST", path: "/api/v1/users/u-learner1/tags" },
      { method: "POST", path: "/api/v1/users/u-learner1/lifecycle/activate" },
      { method: "GET", path: "/api/v1/users/u-learner1" },
    ] as const) {
      await expect(guarded.call(req)).rejects.toBeInstanceOf(GuardStop);
    }
    expect(fake.writes).toEqual([]);
  });
  it("refuses an alias, an email, or a user the list never held, and any kept id in the query or a comma list", async () => {
    const fake = makeFake();
    const found = await load(fake);
    if (!found.ok) throw new Error(found.error.why);
    const portal = guardedPortal(fake.portal, found.value);
    const refused = [
      { method: "DELETE", path: "/api/v1/users/me" },
      { method: "DELETE", path: "/api/v1/users/nileadmin%40example.com" },
      { method: "DELETE", path: "/api/v1/users/u-never-listed" },
      { method: "POST", path: "/api/v1/users/me/lifecycle/deactivate" },
      { method: "DELETE", path: "/api/v1/users/u-learner1?id=u-root" },
      {
        method: "DELETE",
        path: "/api/v1/users/u-learner1",
        body: { ids: "u-learner1,u-root" },
      },
    ] as const;
    for (const req of refused) {
      await expect(portal.call(req)).rejects.toBeInstanceOf(GuardStop);
    }
    expect(fake.writes).toEqual([]);
  });
});
