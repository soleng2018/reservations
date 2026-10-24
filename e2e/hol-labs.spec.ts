import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { z } from "zod";
import {
  AUTHENTIK_URL,
  admin,
  authentikGet,
  authentikLogin,
  haveApi,
  haveProvisioning,
  haveSecrets,
  learner,
  makeTestbedGroup,
  provision,
  removeGroup,
  results,
} from "./authentik";

// HOL Labs, the login Cloudflare Access uses for the lab VMs, against the
// real shared Authentik (spec 0003 AC-19, spec 0012 AC-9, spec 0017 AC-12). A
// learner passes only while in a group marked `hol_testbed_group = true`;
// staff and admins always pass. This needs the marker based gate in place
// (`npm run authentik:setup -- --apply`, run by the owner).
//
// The test puts hol-test-learner in its own throwaway groups, one marked and
// one not, never a testbed's: no Cloudflare policy names them, so no VM opens,
// and the access reconciler only manages the groups of testbeds. Codes meant
// for Cloudflare are caught in the browser and never reach it; the test swaps
// one for tokens itself to read the groups claim.
const secret = (name: string) => {
  const file = join(homedir(), "secrets", name);
  return existsSync(file) ? readFileSync(file, "utf8").trim() : undefined;
};
const labsClientSecret = secret("hol_labs_client_secret");

test.skip(
  !haveSecrets || !haveApi || !haveProvisioning || !labsClientSecret,
  "hol-test and HOL Labs secrets are not on this machine",
);

// Writes go only to the test's own groups. A leftover from a failed run is
// reused, so a rerun never trips on its name.
const TEST_GROUP = "dev-e2e-hol-labs";
const PLAIN_GROUP = "dev-e2e-hol-labs-plain";

type Labs = {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly authorize: string;
};

const labsApp = async (): Promise<Labs> => {
  const provider = (
    await authentikGet(
      results(
        z.looseObject({
          name: z.string(),
          client_id: z.string(),
          redirect_uris: z.array(z.object({ url: z.string() })),
        }),
      ),
      `/providers/oauth2/?name=${encodeURIComponent("HOL Labs")}`,
    )
  ).results.find((p) => p.name === "HOL Labs");
  const redirectUri = provider?.redirect_uris[0]?.url ?? "";
  const url = new URL(`${AUTHENTIK_URL}/application/o/authorize/`);
  url.search = new URLSearchParams({
    client_id: provider?.client_id ?? "",
    response_type: "code",
    scope: "openid email profile",
    state: "e2e",
    redirect_uri: redirectUri,
  }).toString();
  return {
    clientId: provider?.client_id ?? "",
    redirectUri,
    authorize: url.href,
  };
};

// The cloudflare-integration authorize URL, for the isolation check.
const cloudflareIntegration = async (): Promise<string> => {
  const app = (
    await authentikGet(
      results(
        z.looseObject({ slug: z.string(), provider: z.number().nullable() }),
      ),
      "/core/applications/?superuser_full_list=true&page_size=100",
    )
  ).results.find((a) => a.slug === "cloudflare-integration");
  const provider = await authentikGet(
    z.looseObject({
      client_id: z.string(),
      redirect_uris: z.array(z.object({ url: z.string() })),
    }),
    `/providers/oauth2/${app?.provider}/`,
  );
  const url = new URL(`${AUTHENTIK_URL}/application/o/authorize/`);
  url.search = new URLSearchParams({
    client_id: provider.client_id,
    response_type: "code",
    scope: "openid",
    state: "e2e",
    redirect_uri: provider.redirect_uris[0]?.url ?? "",
  }).toString();
  return url.href;
};

// Signs in through HOL Labs in a fresh browser, catching the code before it
// can reach Cloudflare, and returns it, or null when Authentik denied the
// sign in. Authentik's authorize endpoint hands the code over in a 302, and
// a route never sees a redirect hop, so the test fetches that response
// itself without following it. Any other request to the Cloudflare host is
// answered here too.
async function tryLabs(
  browser: Browser,
  labs: Labs,
  who: typeof learner,
  then?: (page: Page) => Promise<void>,
): Promise<string | null> {
  const context = await browser.newContext();
  const callback = new URL(labs.redirectUri);
  let code: string | null = null;
  const caught = (url: string) => {
    code = new URL(url).searchParams.get("code");
    return {
      status: 200,
      contentType: "text/plain",
      body: "caught by the test",
    };
  };
  await context.route(
    (url) => url.href.startsWith(`${AUTHENTIK_URL}/application/o/authorize/`),
    async (route) => {
      const response = await route.fetch({ maxRedirects: 0 });
      const location = response.headers()["location"] ?? "";
      if (location.startsWith(callback.origin))
        await route.fulfill(caught(location));
      else await route.fulfill({ response });
    },
  );
  await context.route(
    (url) => url.origin === callback.origin,
    (route) => route.fulfill(caught(route.request().url())),
  );
  const page = await context.newPage();
  try {
    await page.goto(labs.authorize);
    await authentikLogin(page, who);
    const denied = page.getByText("Request has been denied.");
    const caught = page.getByText("caught by the test");
    await expect(denied.or(caught)).toBeVisible({ timeout: 20_000 });
    if (then) await then(page);
    return code;
  } finally {
    await context.close();
  }
}

// Swaps a code for tokens and reads the id token's groups claim.
async function groupsClaim(labs: Labs, code: string): Promise<string[]> {
  const res = await fetch(`${AUTHENTIK_URL}/application/o/token/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: labs.redirectUri,
      client_id: labs.clientId,
      client_secret: labsClientSecret ?? "",
    }),
  });
  expect(res.ok, `token exchange → ${res.status}`).toBe(true);
  const { id_token } = z
    .object({ id_token: z.string() })
    .parse(await res.json());
  const payload = id_token.split(".")[1] ?? "";
  return z
    .object({ groups: z.array(z.string()).default([]) })
    .parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")))
    .groups;
}

let labs: Labs;
let groupPk = "";
let plainPk = "";
let learnerPk = 0;

// The pk of the group with exactly this name, made if it is not there yet.
async function ensureGroup(name: string, marked: boolean): Promise<string> {
  const existing = (
    await authentikGet(
      results(z.looseObject({ pk: z.string(), name: z.string() })),
      `/core/groups/?name=${name}`,
    )
  ).results.find((g) => g.name === name);
  return existing?.pk ?? (await makeTestbedGroup(name, marked));
}

test.beforeAll(async () => {
  labs = await labsApp();
  learnerPk =
    (
      await authentikGet(
        results(z.looseObject({ pk: z.number(), username: z.string() })),
        `/core/users/?username=${encodeURIComponent(learner.username)}`,
      )
    ).results.find((u) => u.username === learner.username)?.pk ?? 0;
  groupPk = await ensureGroup(TEST_GROUP, true);
  plainPk = await ensureGroup(PLAIN_GROUP, false);
});

test.afterAll(async () => {
  if (groupPk) await removeGroup(groupPk);
  if (plainPk) await removeGroup(plainPk);
});

// Group changes reach Authentik's policy result within seconds (spike 3), so
// each check retries in a fresh browser until it holds.
const settle = { timeout: 45_000, intervals: [2_000, 5_000] };

// covers: spec 0003 AC-17, AC-19, spec 0017 AC-12
test("a learner passes HOL Labs only while in a marked testbed group", async ({
  browser,
}) => {
  expect(learnerPk).toBeGreaterThan(0);
  const otherApp = await cloudflareIntegration();
  try {
    await expect(async () => {
      expect(await tryLabs(browser, labs, learner)).toBeNull();
    }).toPass(settle);

    // A group without the marker opens nothing. Group changes settle within
    // seconds, so wait before the one check that must stay closed.
    await provision("POST", `/core/groups/${plainPk}/add_user/`, {
      pk: learnerPk,
    });
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    expect(await tryLabs(browser, labs, learner)).toBeNull();

    await provision("POST", `/core/groups/${groupPk}/add_user/`, {
      pk: learnerPk,
    });
    let code: string | null = null;
    await expect(async () => {
      code = await tryLabs(browser, labs, learner, async (page) => {
        // Still on hol/learners: every other app stays closed (AC-17).
        await page.goto(otherApp).catch(() => undefined);
        await expect(page.getByText("Request has been denied.")).toBeVisible();
      });
      expect(code).not.toBeNull();
    }).toPass(settle);
    expect(await groupsClaim(labs, code ?? "")).toContain(TEST_GROUP);
  } finally {
    for (const pk of [groupPk, plainPk])
      await provision("POST", `/core/groups/${pk}/remove_user/`, {
        pk: learnerPk,
      });
  }

  await expect(async () => {
    expect(await tryLabs(browser, labs, learner)).toBeNull();
  }).toPass(settle);
});

// covers: spec 0003 AC-19
test("an admin passes HOL Labs with no testbed group", async ({ browser }) => {
  expect(await tryLabs(browser, labs, admin)).not.toBeNull();
});

// covers: spec 0003 AC-13, AC-19
test("HOL Labs has its own empty flow and only hol-labs-access bound", async () => {
  const flow = (
    await authentikGet(
      results(
        z.looseObject({
          pk: z.string(),
          slug: z.string(),
          policybindingmodel_ptr_id: z.string(),
        }),
      ),
      "/flows/instances/?slug=hol-lab-authorization",
    )
  ).results.find((f) => f.slug === "hol-lab-authorization");
  const policyNames = async (target: string | undefined) =>
    (
      await authentikGet(
        results(
          z.looseObject({
            policy_obj: z.looseObject({ name: z.string() }).nullable(),
          }),
        ),
        `/policies/bindings/?target=${target}`,
      )
    ).results.map((b) => b.policy_obj?.name ?? null);

  expect(await policyNames(flow?.policybindingmodel_ptr_id)).toEqual([]);
  const app = (
    await authentikGet(
      results(z.looseObject({ pk: z.string(), slug: z.string() })),
      "/core/applications/?superuser_full_list=true&slug=hol-labs",
    )
  ).results.find((a) => a.slug === "hol-labs");
  expect(await policyNames(app?.pk)).toEqual(["hol-labs-access"]);
  const provider = (
    await authentikGet(
      results(
        z.looseObject({ name: z.string(), authorization_flow: z.string() }),
      ),
      `/providers/oauth2/?name=${encodeURIComponent("HOL Labs")}`,
    )
  ).results.find((p) => p.name === "HOL Labs");
  expect(provider?.authorization_flow).toBe(flow?.pk);
});
