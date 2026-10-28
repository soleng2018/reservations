import { expect } from "@playwright/test";
import { test } from "./admin-session";
import { accountMenu, haveSecrets, learner, signIn } from "./authentik";
import { expectNoSeriousViolations } from "./axe";

// Spec 0005 AC-17: every signed in user has the avatar menu with name, email
// and Sign out; it works by keyboard and passes axe when open.
test.skip(!haveSecrets, "hol-test passwords are not on this machine");

// covers: AC-17
test("the admin sidebar menu shows name, email and Sign out", async ({
  adminPage: page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/admin/testbed-types");
  const trigger = accountMenu(page);
  await expect(trigger).toBeVisible();
  await trigger.focus();
  await page.keyboard.press("Enter");
  const panel = page.locator("[data-slot=popover-content]");
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("button", { name: "Sign out" })).toBeVisible();
  await expect(panel.locator("p").nth(1)).toContainText("@");
  await expectNoSeriousViolations(page);
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(trigger).toBeFocused();
});

// covers: AC-17, AC-1 (spec 0009)
test("a signed in learner has the avatar on / and on /reservations", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, "/reservations", learner);
  await expect(accountMenu(page)).toBeVisible();
  await page.goto("/");
  await accountMenu(page).click();
  await expect(
    page.locator("[data-slot=popover-content]").getByText("@"),
  ).toBeVisible();
  await expectNoSeriousViolations(page);
  await context.close();
});
