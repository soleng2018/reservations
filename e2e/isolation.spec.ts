import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { z } from "zod";
import {
  AUTHENTIK_URL,
  admin,
  authentikGet,
  authentikLogin,
  haveApi,
  haveSecrets,
  learner,
  results,
  signIn,
} from "./authentik";

// Learner isolation against the real shared Authentik (spec 0003, AC-17).
// hol-test-learner is on hol/learners; hol-test-admin is not.
test.skip(!haveSecrets || !haveApi, "hol-test secrets are not on this machine");

type OtherApp = {
  readonly slug: string;
  readonly url: string; // Authentik authorize URL for this app
  readonly host: string; // where an authorization code would go
  readonly launch: string; // the app's own URL
};

// Every app starts at its provider's Authentik authorize URL. That runs the
// same authorization flow as opening the app, without depending on the app's
// host being up (traefik-apps sits behind a Cloudflare Tunnel).
const OTHER_APPS = [
  ["leo", "proxy"],
  ["traefik-apps", "proxy"],
  ["cloudflare-integration", "oauth2"],
] as const;

async function otherApps(): Promise<readonly OtherApp[]> {
  const apps = (
    await authentikGet(
      results(
        z.looseObject({
          slug: z.string(),
          provider: z.number().nullable(),
          launch_url: z.string().nullable().optional(),
        }),
      ),
      "/core/applications/?page_size=100",
    )
  ).results;
  return Promise.all(
    OTHER_APPS.map(async ([slug, kind]): Promise<OtherApp> => {
      const app = apps.find((a) => a.slug === slug);
      const provider = await authentikGet(
        z.looseObject({
          client_id: z.string(),
          redirect_uris: z.array(z.object({ url: z.string() })),
        }),
        `/providers/${kind}/${app?.provider}/`,
      );
      const redirect = provider.redirect_uris[0]?.url ?? "";
      const authorize = new URL(`${AUTHENTIK_URL}/application/o/authorize/`);
      authorize.search = new URLSearchParams({
        client_id: provider.client_id,
        response_type: "code",
        scope: "openid",
        state: "e2e",
        redirect_uri: redirect,
      }).toString();
      return {
        slug,
        url: authorize.href,
        host: new URL(redirect).host,
        launch: app?.launch_url ?? "",
      };
    }),
  );
}

// Any request that hands an authorization code to another app's host.
function watchCodes(context: BrowserContext, hosts: readonly string[]) {
  const codes: string[] = [];
  context.on("request", (r) => {
    const u = new URL(r.url());
    if (hosts.includes(u.host) && u.searchParams.has("code"))
      codes.push(u.href);
  });
  return codes;
}

async function expectDenied(page: Page) {
  await expect(page.getByText("Request has been denied.")).toBeVisible();
  expect(new URL(page.url()).origin).toBe(AUTHENTIK_URL);
}

// A navigation can abort while an app redirects to Authentik; the page still lands.
const open = (page: Page, url: string) => page.goto(url).catch(() => undefined);

let apps: readonly OtherApp[] = [];
test.beforeAll(async () => {
  apps = await otherApps();
});

// covers: AC-17
test("a learner in a clean browser is denied every other app", async ({
  browser,
}) => {
  for (const app of apps) {
    const context = await browser.newContext();
    const codes = watchCodes(context, [app.host]);
    const page = await context.newPage();
    await open(page, app.url);
    await authentikLogin(page, learner);
    await expectDenied(page);
    expect(codes, app.slug).toEqual([]);
    await context.close();
  }
});

// covers: AC-17 (the cached pass from HOL must not carry to another app)
test("a learner who just signed in to HOL is still denied every other app", async ({
  context,
  page,
}) => {
  const codes = watchCodes(
    context,
    apps.map((a) => a.host),
  );
  await signIn(page, "/reservations", learner);
  await expect(page).toHaveURL(/\/reservations$/);
  for (const app of apps) {
    await open(page, app.url);
    await expectDenied(page);
  }
  expect(codes).toEqual([]);
});

// covers: AC-17
test("a learner denied another app first can still sign in to HOL", async ({
  page,
}) => {
  const leo = apps.find((a) => a.slug === "leo");
  await open(page, leo?.url ?? "");
  await authentikLogin(page, learner);
  await expectDenied(page);
  await signIn(page, "/reservations", learner);
  await expect(page).toHaveURL(/\/reservations$/);
});

// covers: AC-17
test("an admin opens leo before and after signing in to HOL", async ({
  page,
}) => {
  const leo = apps.find((a) => a.slug === "leo");
  await open(page, leo?.launch ?? "");
  await authentikLogin(page, admin);
  await expect.poll(() => new URL(page.url()).host).toBe(leo?.host);
  await signIn(page, "/l0gin", admin);
  await expect(page).toHaveURL(/\/admin\/testbed-types$/);
  await open(page, leo?.launch ?? "");
  await expect.poll(() => new URL(page.url()).host).toBe(leo?.host);
});

// covers: AC-17 (the login form itself is not bound)
test("a plain Authentik login with no app still works for a learner", async ({
  page,
}) => {
  await page.goto(`${AUTHENTIK_URL}/if/flow/default-authentication-flow/`);
  await authentikLogin(page, learner);
  await expect(page).toHaveURL(/\/if\/user\//);
  await expect(page.getByText("Request has been denied.")).toHaveCount(0);
});

// covers: AC-13, AC-17
test("the policy is bound on both default flows and HOL's flow has none", async () => {
  const flow = z.looseObject({
    pk: z.string(),
    slug: z.string(),
    policybindingmodel_ptr_id: z.string(),
  });
  const flowBySlug = async (slug: string) =>
    (
      await authentikGet(results(flow), `/flows/instances/?slug=${slug}`)
    ).results.find((f) => f.slug === slug);
  const bindingsOn = async (slug: string) =>
    (
      await authentikGet(
        results(
          z.looseObject({
            policy_obj: z.looseObject({ name: z.string() }).nullable(),
          }),
        ),
        `/policies/bindings/?target=${(await flowBySlug(slug))?.policybindingmodel_ptr_id}`,
      )
    ).results.map((b) => b.policy_obj?.name);

  for (const slug of [
    "default-provider-authorization-implicit-consent",
    "default-provider-authorization-explicit-consent",
  ])
    expect(await bindingsOn(slug), slug).toEqual(["hol-learner-isolation"]);
  expect(await bindingsOn("hol-authorization")).toEqual([]);

  const hol = await authentikGet(
    results(
      z.looseObject({ name: z.string(), authorization_flow: z.string() }),
    ),
    `/providers/oauth2/?name=${encodeURIComponent("Provider for HOL")}`,
  );
  expect(hol.results[0]?.authorization_flow).toBe(
    (await flowBySlug("hol-authorization"))?.pk,
  );
});
