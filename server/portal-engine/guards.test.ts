import { describe, expect, it } from "vitest";
import {
  computeProtected,
  guardedPortal,
  isGuardedWrite,
  NO_PROTECTION,
} from "./guards";
import { GuardStop } from "./stop";
import { baselineState, makeFake, populatedState } from "./testing";

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
      req.path.startsWith("/api/v1/settings/radius")
        ? { status: 404, body: {} }
        : real(req);
    expect((await computeProtected(fake.portal, noSleep)).ok).toBe(true);
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

  it("lets a delete of an unprotected record through", async () => {
    const { fake, prot } = await protectedFor();
    const sent = await guardedPortal(fake.portal, prot).call({
      method: "DELETE",
      path: "/api/v1/settings/ssids/ssid-lookalike",
    });
    expect(sent.ok).toBe(true);
    expect(fake.writes).toHaveLength(1);
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
