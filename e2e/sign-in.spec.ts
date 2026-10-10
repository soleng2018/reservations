import { expect, test } from "@playwright/test";
import {
  ADMIN_ENTRY,
  AUTHENTIK_URL,
  admin,
  authentikSessions,
  haveApi,
  haveSecrets,
  learner,
  signIn,
} from "./authentik";

// Real Authentik sign in with the hol-test fixture accounts (spec 0003).
test.skip(!haveSecrets, "hol-test passwords are not on this machine");

// AC-12: sign out never visits Authentik, ends every Authentik session of
// the user, and the next sign in asks for the password again.
async function expectSignedOutOfAuthentik(
  page: import("@playwright/test").Page,
  username: string,
  visited: readonly string[],
  entry: string,
) {
  expect(visited.filter((u) => u.startsWith(AUTHENTIK_URL))).toEqual([]);
  if (haveApi) expect(await authentikSessions(username)).toEqual([]);
  await page.goto(entry);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(
    page.getByRole("textbox", { name: /email or username/i }),
  ).toBeVisible();
}

// covers: AC-1, AC-2, AC-12
test("an admin signs in at the entry page, lands on the console, and signs out back to it", async ({
  page,
}) => {
  await signIn(page, ADMIN_ENTRY, admin);
  await expect(page).toHaveURL(/\/admin\/testbed-types$/);
  await expect(
    page.getByRole("heading", { name: "Testbed Types" }),
  ).toBeVisible();
  await expect(page.locator('input[type="password"]')).toHaveCount(0);

  const visited: string[] = [];
  page.on("framenavigated", (f) => visited.push(f.url()));
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(new RegExp(`${ADMIN_ENTRY}$`));
  await expectSignedOutOfAuthentik(page, admin.username, visited, ADMIN_ENTRY);
});

// covers: AC-2, AC-12
test("a learner signs in at /reservations, stays there, and signs out to /", async ({
  page,
}) => {
  await signIn(page, "/reservations", learner);
  await expect(page).toHaveURL(/\/reservations$/);
  await expect(page.getByText(/signed in as/i)).toBeVisible();

  const visited: string[] = [];
  page.on("framenavigated", (f) => visited.push(f.url()));
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/:3000\/$/);
  await expectSignedOutOfAuthentik(
    page,
    learner.username,
    visited,
    "/reservations",
  );
});

// covers: AC-2
test("a learner who signs in at the admin entry still lands on /reservations", async ({
  page,
}) => {
  await signIn(page, ADMIN_ENTRY, learner);
  await expect(page).toHaveURL(/\/reservations$/);
});

// covers: AC-2
test("a learner who opens /admin is told they are not authorized", async ({
  page,
}) => {
  await signIn(page, "/reservations", learner);
  await expect(page).toHaveURL(/\/reservations$/);
  await page.goto("/admin");
  await expect(page).toHaveURL(/reason=not_authorized/);
  await expect(page.getByText(/not authorized/i)).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Admin" })).toHaveCount(0);
});
