import "server-only";
import type { Kysely } from "kysely";
import { z } from "zod";
import type { PortalResetSignInReason } from "@/lib/db-enums";
import { portalOrigin, tenantMatches } from "@/lib/portal-reset/portal-host";
import { holdsRun } from "@/lib/portal-reset/sign-in";
import { SIGN_IN_RETRY_DELAY } from "@/lib/portal-reset/timing";
import { err, ok, type Result } from "@/lib/result";
import {
  ensureAutomationCredential,
  type CredentialFailure,
} from "@/server/authentik/portal-automation";
import type { CoreApi } from "@/server/authentik/client";
import { audit } from "@/server/audit";
import type { DB } from "@/server/db/types";
import type { ClaimedRun } from "./claim";
import { makePortalClient } from "./client";
import type { PortalClient, PortalRequest } from "./portal";
import type { SignInError } from "./run";
import type { SignedIn, SignInInput } from "./sign-in";
import { SessionLost } from "./stop";

// From a claimed run to a portal client that is signed in, in the right
// tenant, and safe to call (spec 0023 AC-12 to AC-17, AC-42, AC-43). The
// browser sign in and the fetch are injected, so the whole pipeline runs in
// tests against the fake Authentik with no browser.

export type ConnectDeps = {
  readonly conn: Kysely<DB>;
  readonly api: CoreApi;
  readonly browserSignIn: (
    input: SignInInput,
  ) => Promise<Result<SignedIn, PortalResetSignInReason>>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly fetchImpl?: typeof fetch;
};

// What discovery needs beyond calls: the open browser and its cookies.
export type ConnectedPortal = PortalClient & {
  readonly signedIn: () => SignedIn;
};

async function auditCredential(
  conn: Kysely<DB>,
  runId: string,
  domain: string,
  what: { readonly created: true } | { readonly failed: CredentialFailure },
): Promise<void> {
  await audit(conn, {
    actorUserId: null,
    action:
      "created" in what
        ? "portal_reset.automation_user_created"
        : "portal_reset.credential_failed",
    targetType: "portal_reset_run",
    targetId: runId,
    summary:
      "created" in what
        ? "Created the portal automation user"
        : "The portal automation account could not be prepared",
    // The domain and a closed word; never the password (AC-42).
    metadata: "created" in what ? { domain } : { domain, result: what.failed },
  });
}

type Testbed = {
  readonly domain: string;
  readonly groupName: string;
  readonly origin: string;
};

// AC-7, AC-43: the testbed as it is now, or why the run cannot go on.
async function loadTestbed(
  conn: Kysely<DB>,
  testbedId: string,
): Promise<Testbed | undefined> {
  const row = await conn
    .selectFrom("testbeds")
    .select(["domain", "group_name", "portal_url"])
    .where("id", "=", testbedId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!row || row.domain === null) return undefined;
  const origin = portalOrigin(row.portal_url);
  return origin === null
    ? undefined
    : { domain: row.domain, groupName: row.group_name, origin };
}

// One attempt: make the credential right, then sign in with it.
async function attempt(
  deps: ConnectDeps,
  run: ClaimedRun,
  tb: Testbed,
): Promise<Result<SignedIn, PortalResetSignInReason>> {
  const cred = await ensureAutomationCredential(deps.api, {
    domain: tb.domain,
    groupName: tb.groupName,
  });
  if (!cred.ok) {
    await auditCredential(deps.conn, run.id, tb.domain, { failed: cred.error });
    return err("credential_failed");
  }
  if (cred.value.created)
    await auditCredential(deps.conn, run.id, tb.domain, { created: true });
  return deps.browserSignIn({
    origin: tb.origin,
    username: cred.value.username,
    password: cred.value.password,
  });
}

// AC-14: a transient failure is tried once more after 20 seconds.
async function signInWithRetry(
  deps: ConnectDeps,
  run: ClaimedRun,
  tb: Testbed,
): Promise<Result<SignedIn, PortalResetSignInReason>> {
  const first = await attempt(deps, run, tb);
  if (first.ok || holdsRun(first.error)) return first;
  await deps.sleep(SIGN_IN_RETRY_DELAY);
  return attempt(deps, run, tb);
}

const Userinfo = z.object({ tenantId: z.uuid() });
const Tenant = z.object({ name: z.string().min(1).max(200) });

// AC-16: the signed in tenant must be this domain's. A tenant that cannot be
// read as expected is a mismatch: nothing is written on a guess.
export async function checkTenant(
  client: PortalClient,
  domain: string,
): Promise<Result<void, SignInError>> {
  const info = await client.call({ method: "GET", path: "/api/v1/userinfo" });
  if (!info.ok) return err({ kind: "sign_in", reason: "portal_unreachable" });
  const id = Userinfo.safeParse(info.value.body);
  if (info.value.status !== 200 || !id.success)
    return err({ kind: "tenant_mismatch" });
  const tenant = await client.call({
    method: "GET",
    path: `/api/tenants/${id.data.tenantId}`,
  });
  if (!tenant.ok) return err({ kind: "sign_in", reason: "portal_unreachable" });
  const named = Tenant.safeParse(tenant.value.body);
  return tenant.value.status === 200 &&
    named.success &&
    tenantMatches(named.data.name, domain)
    ? ok(undefined)
    : err({ kind: "tenant_mismatch" });
}

// AC-17: a 401 is answered with one fresh sign in for the run and a retry of
// that call. A second 401, or a refused fresh sign in, ends the run as a sign
// in failure (`SessionLost`).
function withResignIn(
  first: SignedIn,
  fetchImpl: typeof fetch | undefined,
  resign: () => Promise<Result<SignedIn, PortalResetSignInReason>>,
): ConnectedPortal {
  const build = (s: SignedIn) => makePortalClient(s.session, fetchImpl);
  const state = { signed: first, client: build(first), resigned: false };
  const call = async (req: PortalRequest) => {
    const sent = await state.client.call(req);
    if (!sent.ok || sent.value.status !== 401) return sent;
    if (state.resigned) throw new SessionLost("token_missing");
    state.resigned = true;
    const fresh = await resign();
    if (!fresh.ok) throw new SessionLost(fresh.error);
    await state.signed.session.close();
    state.signed = fresh.value;
    state.client = build(fresh.value);
    const again = await state.client.call(req);
    if (again.ok && again.value.status === 401)
      throw new SessionLost("token_missing");
    return again;
  };
  return {
    call,
    close: () => state.signed.session.close(),
    signedIn: () => state.signed,
  };
}

export const connect =
  (deps: ConnectDeps) =>
  async (run: ClaimedRun): Promise<Result<ConnectedPortal, SignInError>> => {
    const tb = await loadTestbed(deps.conn, run.testbedId);
    if (tb === undefined) return err({ kind: "testbed_unavailable" });
    const signed = await signInWithRetry(deps, run, tb);
    if (!signed.ok) return err({ kind: "sign_in", reason: signed.error });
    const portal = withResignIn(signed.value, deps.fetchImpl, () =>
      attempt(deps, run, tb),
    );
    const tenant = await checkTenant(portal, tb.domain);
    if (!tenant.ok) {
      await portal.close();
      return tenant;
    }
    return ok(portal);
  };
