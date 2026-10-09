import { expect, test, type Page } from "@playwright/test";
import { z } from "zod";
import {
  ADMIN_ENTRY,
  admin,
  authentikGet,
  haveApi,
  haveSecrets,
  results,
  signIn,
} from "./authentik";

// The core booking loop end to end (spec 0004), against the real database
// and real Authentik. It commits what it creates (a type, a testbed and its
// pod group, a learner, a booking), all named `e2e ` / `dev-` so they can be
// found and cleaned up by hand; the app has no delete yet.
test.skip(!haveSecrets, "hol-test passwords are not on this machine");

const id = crypto.randomUUID().slice(0, 8);
const typeName = `e2e type ${id}`;
const testbedName = `e2e bench ${id}`;
const slug = `e2e-bench-${id}`;
const email = `dev-guest-${id}@nile-test.invalid`;

async function choose(page: Page, combobox: string, option: string) {
  await page.getByRole("combobox", { name: combobox }).click();
  const item = page.getByRole("option", { name: option, exact: true });
  await item.scrollIntoViewIfNeeded();
  await item.click();
}

// covers: AC-1, AC-2, AC-3, AC-5, AC-6
test("an admin creates a type and a testbed, then a guest books it", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);

  // AC-1, AC-2: the admin side.
  await signIn(page, ADMIN_ENTRY, admin);
  await expect(page).toHaveURL(/\/admin$/);
  await page.getByLabel("Name").first().fill(typeName);
  await page.getByLabel("Duration").fill("1");
  await page.getByRole("button", { name: "Create type" }).click();
  await expect(page.getByText(`Created ${typeName}.`)).toBeVisible();
  await expect(page.getByRole("cell", { name: typeName })).toBeVisible();

  const testbedForm = page.locator("form", {
    has: page.getByRole("button", { name: "Create testbed" }),
  });
  await testbedForm.getByLabel("Name").fill(testbedName);
  await choose(page, "Type", typeName);
  await testbedForm
    .getByLabel("Nile Portal URL")
    .fill("https://portal.nile-test.invalid");
  await testbedForm.getByLabel("LMS URL").fill("https://lms.nile-test.invalid");
  await page.getByRole("button", { name: "Create testbed" }).click();
  await expect(page.getByText(`Created ${testbedName}.`)).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole("cell", { name: `pod-${slug}` })).toBeVisible();

  if (haveApi) {
    const groups = await authentikGet(
      results(
        z.looseObject({ name: z.string(), attributes: z.looseObject({}) }),
      ),
      `/core/groups/?name=pod-${slug}`,
    );
    expect(groups.results).toHaveLength(1);
    expect(groups.results[0]?.attributes.hol_testbed_id).toEqual(
      expect.any(String),
    );
  }

  // AC-3, AC-5, AC-6: a guest in a fresh browser, with no session.
  const guest = await browser.newPage({ timezoneId: "America/New_York" });
  await guest.goto("/book");
  await guest.getByLabel("Name").fill("E2E Guest");
  await guest.getByLabel("Company").fill("Nile test");
  await guest.getByLabel("Email").fill(email);
  await expect(guest.getByRole("combobox", { name: "Timezone" })).toHaveText(
    /America\/New York/,
  );
  await choose(guest, "Lab type", typeName);
  const first = guest.locator('input[name="startsAt"]').first();
  await expect(first).toBeAttached({ timeout: 20_000 });
  await guest.locator("fieldset label").first().click();
  // Cloudflare's test keys pass at once; wait for the token to land.
  await expect(
    guest.locator('input[name="cf-turnstile-response"]'),
  ).not.toHaveValue("", { timeout: 20_000 });
  await guest.getByRole("button", { name: "Confirm booking" }).click();

  await expect(guest.getByText("Your lab is booked")).toBeVisible({
    timeout: 30_000,
  });
  await expect(guest.getByText(testbedName)).toBeVisible();
  await expect(guest.getByText(typeName)).toBeVisible();
  await expect(guest.getByText(/E[SD]T$/).first()).toBeVisible();
  await expect(
    guest.getByText("Check your email for a link to set your password."),
  ).toBeVisible();

  if (haveApi) {
    const users = await authentikGet(
      results(z.looseObject({ attributes: z.looseObject({}) })),
      `/core/users/?username=${encodeURIComponent(email)}`,
    );
    expect(users.results).toHaveLength(1);
    expect(users.results[0]?.attributes.hol_learner).toBe(true);
  }
});
