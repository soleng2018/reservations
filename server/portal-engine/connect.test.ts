import { sql, type Kysely } from "kysely";
import { afterAll, describe, expect, it } from "vitest";
import { err, ok } from "@/lib/result";
import { db } from "@/server/db";
import { hasDb, inRollback, makeTestbed, makeType } from "@/server/db/testing";
import type { DB } from "@/server/db/types";
import { fakeAuthentik, markedGroup } from "@/server/authentik/testing";
import type { ClaimedRun } from "./claim";
import { connect } from "./connect";
import { secret } from "./secret";
import { SessionLost } from "./stop";
import type { SignedIn } from "./sign-in";

afterAll(() => db().destroy());

const DOMAIN = "nileworkshop-9.com";
const GROUP = "NileWorkshop9Admin";
const TENANT_ID = "0be085a9-aa56-4af8-81bd-18677e67db63";

async function setup(
  trx: Kysely<DB>,
  portalUrl = "https://u1.nile-global.cloud",
) {
  const type = await makeType(trx);
  const testbed = await makeTestbed(trx, type.id, {
    domain: DOMAIN,
    group_name: GROUP,
    portal_url: portalUrl,
  });
  const run = await sql<{ id: string }>`
    insert into hol_app.portal_reset_runs
      (testbed_id, ended_key, event, mode, lab_ended_at, due_at, state)
    values (${testbed.id}::uuid, ${crypto.randomUUID()}, 'lab_ended', 'live',
      now(), now(), 'running')
    returning id`.execute(trx);
  const claimed: ClaimedRun = {
    id: run.rows[0]?.id ?? "",
    testbedId: testbed.id,
    bookingId: null,
    mode: "live",
    labEndedAt: new Date(),
    resumes: 0,
    progress: {},
  };
  return { testbed, run: claimed };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status });

// A portal that answers the two tenant reads, and 401 `denied` times first.
const portalFetch = (
  tenantName: string,
  seen: string[] = [],
  denied = 0,
): typeof fetch => {
  let left = denied;
  return (async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    seen.push(path);
    if (left > 0) {
      left -= 1;
      return json(401, {});
    }
    if (path === "/api/v1/userinfo") return json(200, { tenantId: TENANT_ID });
    if (path === `/api/tenants/${TENANT_ID}`)
      return json(200, { name: tenantName });
    return json(200, {});
  }) as typeof fetch;
};

const signedIn = (closed: string[] = [], tag = "a"): SignedIn => ({
  session: {
    origin: "https://u1.nile-global.cloud",
    headers: secret({ "x-id-token": `tok-${tag}` }),
    close: async () => {
      closed.push(tag);
    },
  },
  // The browser is never touched by the pipeline.
  browser: {} as SignedIn["browser"],
  state: secret({ cookies: [], origins: [] }),
});

const authentikWith = () =>
  fakeAuthentik([], { groups: [markedGroup("g9", GROUP, {}, DOMAIN)] });

describe.skipIf(!hasDb)("connect (AC-12 to AC-17, AC-42, AC-43)", () => {
  it("makes the credential, signs in, checks the tenant, and returns a client", () =>
    inRollback(async (trx) => {
      const { run } = await setup(trx);
      const fake = authentikWith();
      const inputs: string[] = [];
      const result = await connect({
        conn: trx,
        api: fake.api,
        browserSignIn: async (input) => {
          inputs.push(input.username, input.origin);
          return ok(signedIn());
        },
        sleep: async () => undefined,
        fetchImpl: portalFetch("Nile Workshop 9"),
      })(run);
      expect(result.ok).toBe(true);
      expect(inputs).toEqual([
        `automation@${DOMAIN}`,
        "https://u1.nile-global.cloud",
      ]);
      const audits = await trx
        .selectFrom("audit_events")
        .select("action")
        .where("target_id", "=", run.id)
        .execute();
      expect(audits.map((a) => a.action)).toEqual([
        "portal_reset.automation_user_created",
      ]);
    }));

  it("ends testbed_unavailable for a portal address off the allow list, with no browser", () =>
    inRollback(async (trx) => {
      const { run } = await setup(trx, "https://evil.example.test");
      let launched = 0;
      const result = await connect({
        conn: trx,
        api: authentikWith().api,
        browserSignIn: async () => {
          launched += 1;
          return ok(signedIn());
        },
        sleep: async () => undefined,
      })(run);
      expect(result).toEqual({
        ok: false,
        error: { kind: "testbed_unavailable" },
      });
      expect(launched).toBe(0);
    }));

  it("ends testbed_unavailable for a deleted testbed", () =>
    inRollback(async (trx) => {
      const { run, testbed } = await setup(trx);
      await trx
        .updateTable("testbeds")
        .set({ deleted_at: new Date() })
        .where("id", "=", testbed.id)
        .execute();
      const result = await connect({
        conn: trx,
        api: authentikWith().api,
        browserSignIn: async () => ok(signedIn()),
        sleep: async () => undefined,
      })(run);
      expect(result).toEqual({
        ok: false,
        error: { kind: "testbed_unavailable" },
      });
    }));

  it("reports credential_failed and audits it when the group is missing", () =>
    inRollback(async (trx) => {
      const { run } = await setup(trx);
      let launched = 0;
      const result = await connect({
        conn: trx,
        api: fakeAuthentik([]).api,
        browserSignIn: async () => {
          launched += 1;
          return ok(signedIn());
        },
        sleep: async () => undefined,
      })(run);
      expect(result).toEqual({
        ok: false,
        error: { kind: "sign_in", reason: "credential_failed" },
      });
      expect(launched).toBe(0);
      const row = await trx
        .selectFrom("audit_events")
        .select(["action", "metadata"])
        .where("target_id", "=", run.id)
        .executeTakeFirstOrThrow();
      expect(row.action).toBe("portal_reset.credential_failed");
      expect(row.metadata).toEqual({ domain: DOMAIN, result: "group_missing" });
    }));

  it("retries a transient failure once after 20 seconds, then gives the reason", () =>
    inRollback(async (trx) => {
      const { run } = await setup(trx);
      const waits: number[] = [];
      let tries = 0;
      const result = await connect({
        conn: trx,
        api: authentikWith().api,
        browserSignIn: async () => {
          tries += 1;
          return err("timeout");
        },
        sleep: async (ms) => {
          waits.push(ms);
        },
      })(run);
      expect(result).toEqual({
        ok: false,
        error: { kind: "sign_in", reason: "timeout" },
      });
      expect(tries).toBe(2);
      expect(waits).toEqual([20_000]);
    }));

  it("does not retry a refused password", () =>
    inRollback(async (trx) => {
      const { run } = await setup(trx);
      let tries = 0;
      const result = await connect({
        conn: trx,
        api: authentikWith().api,
        browserSignIn: async () => {
          tries += 1;
          return err("idp_rejected");
        },
        sleep: async () => undefined,
      })(run);
      expect(result).toEqual({
        ok: false,
        error: { kind: "sign_in", reason: "idp_rejected" },
      });
      expect(tries).toBe(1);
    }));

  it("sets a different password at each sign in", () =>
    inRollback(async (trx) => {
      const { run } = await setup(trx);
      const fake = authentikWith();
      const seen: string[] = [];
      const deps = {
        conn: trx,
        api: fake.api,
        browserSignIn: async (i: { password: { reveal: () => string } }) => {
          seen.push(i.password.reveal());
          return ok(signedIn());
        },
        sleep: async () => undefined,
        fetchImpl: portalFetch("Nile Workshop 9"),
      };
      await connect(deps)(run);
      await connect(deps)(run);
      expect(seen).toHaveLength(2);
      expect(seen[0]).not.toBe(seen[1]);
    }));

  it("aborts tenant_mismatch, closes the browser, and makes no other call", () =>
    inRollback(async (trx) => {
      const { run } = await setup(trx);
      const closed: string[] = [];
      const seen: string[] = [];
      const result = await connect({
        conn: trx,
        api: authentikWith().api,
        browserSignIn: async () => ok(signedIn(closed)),
        sleep: async () => undefined,
        fetchImpl: portalFetch("Nile Workshop 1", seen),
      })(run);
      expect(result).toEqual({ ok: false, error: { kind: "tenant_mismatch" } });
      expect(closed).toEqual(["a"]);
      expect(seen).toEqual(["/api/v1/userinfo", `/api/tenants/${TENANT_ID}`]);
    }));

  it("signs in once more after a 401 and retries the call (AC-17)", () =>
    inRollback(async (trx) => {
      const { run } = await setup(trx);
      const closed: string[] = [];
      let n = 0;
      const seen: string[] = [];
      // The 401 comes on the first call after the tenant check passes.
      const fetchImpl = (async (input: RequestInfo | URL) => {
        const path = new URL(String(input)).pathname;
        seen.push(path);
        if (path === "/api/v1/userinfo")
          return json(200, { tenantId: TENANT_ID });
        if (path === `/api/tenants/${TENANT_ID}`)
          return json(200, { name: "Nile Workshop 9" });
        return json(
          seen.filter((p) => p === "/api/x").length === 1 ? 401 : 200,
          {},
        );
      }) as typeof fetch;
      const result = await connect({
        conn: trx,
        api: authentikWith().api,
        browserSignIn: async () => ok(signedIn(closed, `s${(n += 1)}`)),
        sleep: async () => undefined,
        fetchImpl,
      })(run);
      if (!result.ok) throw new Error("expected a client");
      const reply = await result.value.call({ method: "GET", path: "/api/x" });
      expect(reply.ok && reply.value.status).toBe(200);
      expect(n).toBe(2);
      expect(closed).toEqual(["s1"]);
    }));

  it("ends the run as a sign in failure on a second 401", () =>
    inRollback(async (trx) => {
      const { run } = await setup(trx);
      let n = 0;
      const fetchImpl = (async (input: RequestInfo | URL) => {
        const path = new URL(String(input)).pathname;
        if (path === "/api/v1/userinfo")
          return json(200, { tenantId: TENANT_ID });
        if (path === `/api/tenants/${TENANT_ID}`)
          return json(200, { name: "Nile Workshop 9" });
        return json(401, {});
      }) as typeof fetch;
      const result = await connect({
        conn: trx,
        api: authentikWith().api,
        browserSignIn: async () => ok(signedIn([], `s${(n += 1)}`)),
        sleep: async () => undefined,
        fetchImpl,
      })(run);
      if (!result.ok) throw new Error("expected a client");
      await expect(
        result.value.call({ method: "GET", path: "/api/x" }),
      ).rejects.toBeInstanceOf(SessionLost);
    }));

  it("ends as a sign in failure, with the browser closed, when the tenant check loses its session", () =>
    inRollback(async (trx) => {
      const { run } = await setup(trx);
      const closed: string[] = [];
      let n = 0;
      const fetchImpl = (async () => json(401, {})) as typeof fetch;
      const result = await connect({
        conn: trx,
        api: authentikWith().api,
        browserSignIn: async () => ok(signedIn(closed, `s${(n += 1)}`)),
        sleep: async () => undefined,
        fetchImpl,
      })(run);
      expect(result).toEqual({
        ok: false,
        error: { kind: "sign_in", reason: "token_missing" },
      });
      expect(closed).toHaveLength(n);
    }));
});
