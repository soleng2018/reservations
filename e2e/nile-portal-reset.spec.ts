import { expect } from "@playwright/test";
import { test } from "./admin-session";
import { haveSecrets } from "./authentik";
import { expectNoSeriousViolations } from "./axe";

// Spec 0022 (tasks 1 to 6): the read only Nile Portal Reset page against the
// real database. Reads only, so it changes nothing.
test.skip(!haveSecrets, "hol-test passwords are not on this machine");

// covers: AC-3, AC-4, AC-10, AC-20, AC-21, AC-24
test("the page opens read only with the 13 starting steps in order", async ({
  adminPage: page,
}) => {
  await page.goto("/admin/nile-portal-reset");
  await expect(
    page.getByRole("heading", { name: "Nile Portal Reset", level: 1 }),
  ).toBeVisible();

  const steps = page.getByRole("list", { name: /Reset steps/ }).locator("> li");
  await expect(steps).toHaveCount(13);
  await expect(steps.first()).toContainText("Integrations");
  await expect(steps.nth(1)).toContainText("SSIDs");
  await expect(steps.nth(1)).toContainText(
    "skipping items where ssid.popTunnelUsed is true",
  );
  await expect(steps.nth(1)).toContainText(
    "SSIDs where ssid.popTunnelUsed is true are never deleted.",
  );
  await expect(steps.nth(5)).toContainText("Service Profiles");
  await expect(steps.nth(5)).toContainText("Disabled");
  await expect(page.getByText("Disabled", { exact: true })).toHaveCount(1);

  await expect(
    page.getByText("Aborted resets will not be emailed."),
  ).toBeVisible();
  await expect(page.getByText("Off", { exact: true })).toBeVisible();

  // No controls to edit anything in the content area.
  const main = page.getByRole("main");
  await expect(main.getByRole("button")).toHaveCount(0);
  await expect(main.getByRole("textbox")).toHaveCount(0);
  await page.screenshot({
    path: "test-results/nile-portal-reset-wide.png",
    fullPage: true,
  });
});

test("the nav lists the page between Users and Audit Log", async ({
  adminPage: page,
}) => {
  await page.goto("/admin/nile-portal-reset");
  const nav = page.getByRole("navigation").first();
  const labels = await nav.getByRole("link").allInnerTexts();
  const clean = labels.map((l) => l.trim());
  expect(clean.indexOf("Nile Portal Reset")).toBe(clean.indexOf("Users") + 1);
  expect(clean.indexOf("Audit Log")).toBe(
    clean.indexOf("Nile Portal Reset") + 1,
  );
  await page.getByRole("link", { name: "History" }).click();
  await expect(page).toHaveURL(/\/admin\/audit-log\?area=portal_reset/);
});

// covers: AC-15
test("at 390px each step is a card and the page does not scroll sideways", async ({
  adminPage: page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/admin/nile-portal-reset");
  await expect(page.getByRole("list", { name: /Reset steps/ })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({
    path: "test-results/nile-portal-reset-narrow.png",
    fullPage: true,
  });
});

test("has no serious accessibility violations", async ({ adminPage: page }) => {
  await page.goto("/admin/nile-portal-reset");
  await expect(page.getByRole("list", { name: /Reset steps/ })).toBeVisible();
  await expectNoSeriousViolations(page);
});
