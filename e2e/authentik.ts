import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { z } from "zod";

// Shared helpers for the real Authentik suites (spec 0003). Secrets live
// outside the repo; without them the suites skip (CI).
const secret = (name: string) => {
  const file = join(homedir(), "secrets", name);
  return existsSync(file) ? readFileSync(file, "utf8").trim() : undefined;
};

export type Who = { readonly username: string; readonly password?: string };

export const admin: Who = {
  username: "hol-test-admin",
  password: secret("hol-test-admin.pw"),
};
// On path hol/learners, so learner isolation applies (AC-17).
export const learner: Who = {
  username: "hol-test-learner@example.test",
  password: secret("hol-test-learner.pw"),
};
export const ADMIN_ENTRY = "/l0gin";
export const AUTHENTIK_URL = "https://authentik.dev.app.nile-global.cloud";
export const haveSecrets = Boolean(admin.password && learner.password);

// Writes for the tests' own throwaway groups go through the provisioning
// token, the app's RBAC limited account. The app never creates a group (spec
// 0017 AC-4): the owner's script makes the real ones, so the tests make theirs
// here, named `dev-e2e-…`, and remove them again.
const provisioningToken = secret("authentik_provisioning_token");
export const haveProvisioning = provisioningToken !== undefined;

// Read only Authentik API calls for the tests (the master token never
// reaches web or worker; this is the test machine).
const masterToken = secret("authentik_master_token");
export const haveApi = masterToken !== undefined;

export async function authentikGet<T>(
  schema: z.ZodType<T>,
  path: string,
): Promise<T> {
  const res = await fetch(`${AUTHENTIK_URL}/api/v3${path}`, {
    headers: {
      Authorization: `Bearer ${masterToken}`,
      Accept: "application/json",
    },
  });
  expect(res.ok, `GET ${path}`).toBe(true);
  return schema.parse(await res.json());
}

export const results = <T extends z.ZodType>(item: T) =>
  z.object({ results: z.array(item) });

// The Authentik login form: identification, then password.
export async function authentikLogin(page: Page, who: Who) {
  await page
    .getByRole("textbox", { name: /email or username/i })
    .fill(who.username);
  await page.getByRole("button", { name: /log in|continue/i }).click();
  await page
    .getByLabel(/password/i)
    .first()
    .fill(who.password ?? "");
  await page.getByRole("button", { name: /continue|log in/i }).click();
}

// Signs in to HOL from an app entry page. With an Authentik session already,
// Authentik skips the form and returns straight to the app, so wait for
// whichever comes first: the login form or the signed in page.
export async function signIn(page: Page, entry: string, who: Who) {
  await page.goto(entry);
  await page.getByRole("button", { name: /sign in/i }).click();
  const form = page.getByRole("textbox", { name: /email or username/i });
  const signedIn = accountMenu(page);
  await expect(form.or(signedIn)).toBeVisible({ timeout: 20_000 });
  if (await form.isVisible()) await authentikLogin(page, who);
}

// The signed in user's avatar button (spec 0005 AC-17).
export function accountMenu(page: Page) {
  return page.getByRole("button", { name: /^Account menu for / });
}

// Opens the account menu and clicks Sign out.
export async function signOutViaMenu(page: Page) {
  await accountMenu(page).click();
  await page.getByRole("button", { name: "Sign out" }).click();
}

// The Authentik sessions a user has right now.
export async function authentikSessions(username: string) {
  return (
    await authentikGet(
      results(z.looseObject({ uuid: z.string() })),
      `/core/authenticated_sessions/?user__username=${encodeURIComponent(username)}&page_size=100`,
    )
  ).results;
}

export async function provision(
  method: "POST" | "DELETE",
  path: string,
  body?: unknown,
) {
  const res = await fetch(`${AUTHENTIK_URL}/api/v3${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${provisioningToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  expect(res.ok, `${method} ${path} → ${res.status}`).toBe(true);
  const text = await res.text();
  return text ? (JSON.parse(text) as unknown) : undefined;
}

// A flat group (no parent, no role) like the owner's script makes. `marked`
// carries `hol_testbed_group = true`, so a testbed can use it; without it the
// app must refuse the group. Returns the group's pk.
export async function makeTestbedGroup(
  name: string,
  marked = true,
  // The `hol_testbed_domain` the add form reads (spec 0017 AC-17, AC-21).
  domain?: string,
): Promise<string> {
  const created = z.object({ pk: z.string() }).parse(
    await provision("POST", "/core/groups/", {
      name,
      attributes: marked
        ? {
            hol_testbed_group: true,
            ...(domain === undefined ? {} : { hol_testbed_domain: domain }),
          }
        : { hol_test: true },
    }),
  );
  return created.pk;
}

export async function removeGroup(pk: string): Promise<void> {
  await provision("DELETE", `/core/groups/${pk}/`);
}
