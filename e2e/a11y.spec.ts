import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
import { adminContext, test } from "./admin-session";
import { ADMIN_ENTRY, haveSecrets } from "./authentik";

// Spec 0005 AC-14: no serious or critical axe violation on the shell, the
// sign in card, /book, and the gallery's dialogs.
test.skip(!haveSecrets, "hol-test passwords are not on this machine");

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function expectNoSeriousViolations(
  page: Page,
  exclude: readonly string[] = [],
) {
  const results = await exclude
    .reduce((axe, sel) => axe.exclude(sel), new AxeBuilder({ page }))
    .withTags(TAGS)
    .analyze();
  const serious = results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map(
      (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
    );
  expect(serious).toEqual([]);
}

// covers: AC-14
test("the shell at 1280px", async ({ adminPage: page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/admin/testbed-types");
  await expect(
    page.getByRole("heading", { name: "Testbed Types" }),
  ).toBeVisible();
  await expectNoSeriousViolations(page);
});

// covers: AC-4, AC-14
test("the shell at 390px with the drawer open", async ({ browser }) => {
  const context = await adminContext(browser, {
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  await page.goto("/admin/testbed-types");
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(page.locator("[data-slot=sheet-content]")).toBeVisible();
  await expectNoSeriousViolations(page);
  await context.close();
});

// covers: AC-10, AC-14
test("the admin sign in card", async ({ page }) => {
  await page.goto(ADMIN_ENTRY);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expectNoSeriousViolations(page);
});

// covers: AC-11, AC-14 (Turnstile is third party content)
test("/book in the learner frame", async ({ page }) => {
  await page.goto("/book");
  await expect(
    page.getByRole("heading", { name: "Reserve a remote lab" }),
  ).toBeVisible();
  await expectNoSeriousViolations(page, [".cf-turnstile"]);
});

// covers: AC-7, AC-8, AC-14
test("the gallery with each dialog open", async ({ adminPage: page }) => {
  await page.goto("/admin/ui-gallery");
  await expectNoSeriousViolations(page);

  await page.getByRole("button", { name: "Open form modal" }).click();
  await expect(
    page.getByRole("dialog", { name: "Add sample type" }),
  ).toBeVisible();
  await expectNoSeriousViolations(page);
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Delete Advanced" }).click();
  await expect(
    page.getByRole("alertdialog", { name: "Delete this?" }),
  ).toBeVisible();
  await expectNoSeriousViolations(page);
  await page.getByRole("button", { name: "Cancel" }).click();

  await page.getByRole("button", { name: "Delete Basic" }).click();
  await expect(
    page.getByRole("dialog", { name: "Testbed type in use" }),
  ).toBeVisible();
  await expectNoSeriousViolations(page);
});
