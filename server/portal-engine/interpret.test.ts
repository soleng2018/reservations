import { describe, expect, it } from "vitest";
import { startingList } from "@/server/portal-reset/starting-list";
import type { ResetStep } from "@/server/portal-reset/steps";
import {
  recheckStep,
  runStep,
  type ItemRecord,
  type StepEnv,
} from "./interpret";
import { baselineState, makeFake, populatedState, type Fake } from "./testing";

const steps: readonly ResetStep[] = startingList().steps.map((e, i) => ({
  id: `id-${i}`,
  position: i + 1,
  featureName: e.featureName,
  enabled: e.enabled,
  note: e.note,
  seedKey: e.key,
  definition: e.definition,
}));

const stepNamed = (key: string): ResetStep => {
  const step = steps.find((s) => s.seedKey === key);
  if (!step) throw new Error(`no step ${key}`);
  return step;
};

function envFor(
  fake: Fake,
  extra: Partial<StepEnv> = {},
): { env: StepEnv; records: ItemRecord[]; sleeps: number[] } {
  const records: ItemRecord[] = [];
  const sleeps: number[] = [];
  return {
    records,
    sleeps,
    env: {
      portal: fake.portal,
      mode: "live",
      pass: 1,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      beforeWrite: async () => undefined,
      isGuarded: () => false,
      record: (r) => records.push(r),
      hidden: new Set(),
      ...extra,
    },
  };
}

const runAll = async (fake: Fake, extra: Partial<StepEnv> = {}) => {
  const { env, records, sleeps } = envFor(fake, extra);
  const results = [];
  for (const step of steps) results.push(await runStep(step, env));
  return { results, records, sleeps };
};

// covers: AC-19, AC-20, AC-22, AC-24
describe("the 13 starting steps", () => {
  it("has 13 steps", () => {
    expect(steps).toHaveLength(13);
  });

  it("bring a populated tenant to the baseline", async () => {
    const fake = makeFake(populatedState());
    const { results } = await runAll(fake);
    expect(results.every((r) => r === "done")).toBe(true);
    expect({ ...fake.state, brandingRestores: 0 }).toEqual(baselineState());
  });

  it("change nothing on a second run", async () => {
    const fake = makeFake(populatedState());
    await runAll(fake);
    const writesBefore = fake.writes.length;
    const second = await runAll(fake);
    expect(second.results.every((r) => r === "done")).toBe(true);
    expect(second.records).toEqual([]);
    expect({ ...fake.state, brandingRestores: 0 }).toEqual(baselineState());
    // The writes a clean tenant still gets, by the starting list's design: the
    // branding restore, the certificate delete (a 404 is fine), the App group
    // the portal refuses (expected), and the guest switch cycled on and off.
    const extra = fake.writes.slice(writesBefore);
    expect(extra.map((w) => `${w.method} ${w.path}`).sort()).toEqual([
      "DELETE /api/v1/cloud-profile/value?profile_name=profiles&profile_type=app_profile&scope_type=tenant",
      "DELETE /api/v1/cloudradius/config/demo/keys",
      "DELETE /api/v3/policy/groups/g-app",
      "PUT /api/v1/guestpop/advance/ga1",
      "PUT /api/v1/guestpop/advance/ga1",
    ]);
  });

  it("deletes each wired batch in a single call", async () => {
    const fake = makeFake(populatedState());
    await runStep(stepNamed("wired-access-management"), envFor(fake).env);
    const batches = fake.writes.filter(
      (w) => w.path === "/api/v1/client-configs",
    );
    // first without the ALL rule, then, once Wired SSO is off, the rest
    expect(batches.map((b) => b.body)).toEqual([
      { ids: ["cc1"] },
      { ids: ["cc-all"] },
    ]);
  });

  it("restores a customised guest portal by the profile's own name", async () => {
    const fake = makeFake(populatedState());
    await runStep(stepNamed("guest-portal-branding"), envFor(fake).env);
    expect(fake.state.brandingRestores).toBe(1);
    expect(fake.state.brandingProfile).toBe("profiles");
    expect(fake.writes.map((w) => w.path)).toEqual([
      "/api/v1/cloud-profile/value?profile_name=t1_V1&profile_type=app_profile&scope_type=tenant",
    ]);
  });

  it("waits only when the guest switch had to be turned on", async () => {
    const off = populatedState();
    off.guestAdvance = [
      { id: "ga1", tenantId: "t1", advanceSettingsEnabled: false },
    ];
    const fake = makeFake(off);
    const { env, sleeps } = envFor(fake);
    await runStep(stepNamed("guest-service-auth-geo-control"), env);
    expect(sleeps).toEqual([10_000]);
    const on = makeFake(populatedState());
    const withOn = envFor(on);
    await runStep(stepNamed("guest-service-auth-geo-control"), withOn.env);
    expect(withOn.sleeps).toEqual([]);
  });
});

// covers: AC-22
describe("silent cases", () => {
  it("records nothing for an empty tenant, a 404 list, and an item gone first", async () => {
    const empty = makeFake(baselineState());
    const run = await runAll(empty);
    expect(run.records).toEqual([]);
    expect(run.results.every((r) => r === "done")).toBe(true);

    const missing = makeFake(populatedState());
    missing.intercept = (req) =>
      req.path.startsWith("/api/v1/siems")
        ? { status: 404, body: { message: "Not found" } }
        : undefined;
    const r2 = await runStep(stepNamed("integrations"), envFor(missing).env);
    // the list 404 is nothing to do; the after read pick is missing, so the
    // expect holds too
    expect(r2).toBe("done");

    const gone = makeFake(populatedState());
    gone.intercept = (req) =>
      req.method === "DELETE" && req.path.endsWith("/wh1")
        ? { status: 404, body: {} }
        : undefined;
    const { env, records } = envFor(gone);
    await runStep(stepNamed("integrations"), env);
    expect(records.some((r) => r.itemId === "wh1")).toBe(false);
  });

  it("accepts a Nile RADIUS never set up, whose TLS config is null", async () => {
    // Workshop 1, 2026-10-29: `eapTLSConfig` is null until someone configures
    // EAP-TLS, so the key delete answers 404 and the check has no value.
    const fake = makeFake(baselineState());
    fake.intercept = (req) =>
      req.path === "/api/v1/cloudradius/config" && req.method === "GET"
        ? { status: 200, body: { usable: false, eapTLSConfig: null } }
        : undefined;
    const { env, records } = envFor(fake);
    expect(await runStep(stepNamed("nile-radius-certificates"), env)).toBe(
      "done",
    );
    expect(records.filter((r) => r.kind === "failed")).toEqual([]);
  });

  it("treats a named refusal as expected and keeps the group", async () => {
    const fake = makeFake(populatedState());
    const { env, records } = envFor(fake);
    expect(await runStep(stepNamed("policy-groups"), env)).toBe("done");
    expect(records.filter((r) => r.kind === "failed")).toEqual([]);
    expect(fake.state.groups.map((g) => g.id)).toEqual(["g-app"]);
  });
});

// covers: AC-21, AC-23, AC-28
describe("failures", () => {
  it("retries a 5xx, records the failure once it is out of attempts, and goes on", async () => {
    const fake = makeFake(populatedState());
    fake.intercept = (req) =>
      req.method === "DELETE" && req.path.endsWith("/wh1")
        ? { status: 500, body: { message: "boom https://x.example/y a@b.co" } }
        : undefined;
    const { env, records, sleeps } = envFor(fake);
    expect(await runStep(stepNamed("integrations"), env)).toBe("failed");
    const attempts = fake.calls.filter(
      (c) => c === "DELETE /api/v1/subscriptions/webhooks/config/wh1",
    );
    expect(attempts).toHaveLength(3);
    expect(sleeps).toEqual([2000, 6000]);
    const failure = records.find((r) => r.kind === "failed");
    expect(failure).toMatchObject({
      itemId: "wh1",
      label: "Hook",
      status: 500,
      method: "DELETE",
      route: "/api/v1/subscriptions/webhooks/config/{id}",
      message: "boom [url] [email]",
    });
    // the other lists were still cleared
    expect(fake.state.siems).toEqual([]);
    expect(fake.state.ddns).toEqual([]);
  });

  it("does not retry another 4xx and fails the step on a bad list shape", async () => {
    const fake = makeFake(populatedState());
    fake.intercept = (req) =>
      req.path.startsWith("/api/v3/policy/service-profiles")
        ? req.method === "GET"
          ? { status: 200, body: { nope: [] } }
          : undefined
        : undefined;
    const { env, records } = envFor(fake);
    expect(await runStep(stepNamed("service-profiles"), env)).toBe("failed");
    expect(records).toHaveLength(1);
    expect(fake.calls).toHaveLength(1);

    const refused = makeFake(populatedState());
    refused.intercept = (req) =>
      req.method === "DELETE" && req.path.includes("/segments/")
        ? { status: 400, body: { errors: [{ message: "in use" }] } }
        : undefined;
    expect(await runStep(stepNamed("segments"), envFor(refused).env)).toBe(
      "failed",
    );
    expect(refused.calls.filter((c) => c.startsWith("DELETE"))).toHaveLength(1);
  });

  it("fails an expect that does not hold", async () => {
    const fake = makeFake(populatedState());
    fake.intercept = (req) =>
      req.method === "DELETE" && req.path.includes("/siems/")
        ? { status: 200, body: {} }
        : undefined;
    const { env, records } = envFor(fake);
    expect(await runStep(stepNamed("integrations"), env)).toBe("failed");
    expect(records.some((r) => r.kind === "failed" && r.itemId === null)).toBe(
      true,
    );
  });
});

// covers: AC-26, AC-6
describe("hooks", () => {
  it("skips a guarded item silently and never sends its delete", async () => {
    const fake = makeFake(populatedState());
    const { env, records } = envFor(fake, {
      isGuarded: (method, path) =>
        method === "DELETE" && path.endsWith("/ssid-guest"),
    });
    expect(await runStep(stepNamed("ssids"), env)).toBe("done");
    expect(fake.state.ssids.map((s) => s.id)).toEqual([
      "ssid-protected",
      "ssid-guest",
    ]);
    expect(records).toEqual([
      expect.objectContaining({ kind: "deleted", itemId: "ssid-lookalike" }),
    ]);
  });

  it("stops where beforeWrite throws and sends nothing more", async () => {
    const fake = makeFake(populatedState());
    const { env } = envFor(fake, {
      beforeWrite: async () => {
        throw new Error("stop");
      },
    });
    await expect(runStep(stepNamed("integrations"), env)).rejects.toThrow(
      "stop",
    );
    expect(fake.writes).toEqual([]);
  });
});

// covers: AC-33
describe("dry run", () => {
  it("sends no write, records would_* and hides virtual deletes from later reads", async () => {
    const fake = makeFake(populatedState());
    const { env, records, sleeps } = envFor(fake, { mode: "dry_run" });
    for (const step of steps) await runStep(step, env);
    expect(fake.writes).toEqual([]);
    expect(sleeps).toEqual([]);
    expect(fake.state).toEqual(populatedState());
    const kinds = new Set(records.map((r) => r.kind));
    expect(kinds).toEqual(new Set(["would_delete", "would_change"]));
    // the second policy-groups part lists the same groups; the App one it
    // would delete is recorded once
    const groupDeletes = records.filter(
      (r) => r.route === "/api/v3/policy/groups/{id}",
    );
    expect(new Set(groupDeletes.map((r) => r.itemId)).size).toBe(
      groupDeletes.length,
    );
  });
});

// covers: AC-19 (the final re-read)
describe("recheckStep", () => {
  const recheckAll = async (fake: Fake) => {
    const { env, records } = envFor(fake);
    const results = [];
    for (const step of steps) results.push(await recheckStep(step, env));
    return { results, records };
  };

  it("finds nothing left on a reset tenant, records nothing, writes nothing", async () => {
    const fake = makeFake(populatedState());
    await runAll(fake);
    const writes = fake.writes.length;
    const { results, records } = await recheckAll(fake);
    expect(results.every(Boolean)).toBe(true);
    expect(records).toEqual([]);
    expect(fake.writes.length).toBe(writes);
  });

  it("reports what is left on a populated tenant as failures, without a write", async () => {
    const fake = makeFake(populatedState());
    const { results, records } = await recheckAll(fake);
    expect(results.some((r) => !r)).toBe(true);
    expect(records.length).toBeGreaterThan(0);
    expect(records.every((r) => r.kind === "failed")).toBe(true);
    expect(
      records.some((r) => r.message === "still there after the step"),
    ).toBe(true);
    expect(fake.writes).toEqual([]);
  });
});
