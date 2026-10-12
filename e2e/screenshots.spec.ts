import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { adminContext, test } from "./admin-session";
import { ADMIN_ENTRY, haveSecrets } from "./authentik";
import { walkScreens } from "./book-flow";

// Spec 0005 AC-15: the shots /check verify compares with the mock. Dialogs
// and the toast come from the gallery, so they need no shared data. Written
// to e2e/screenshots/ (gitignored).
test.skip(!haveSecrets, "hol-test passwords are not on this machine");

const WIDTHS = [
  { name: "1280", width: 1280, height: 800 },
  { name: "390", width: 390, height: 844 },
] as const;

const shot = async (page: Page, width: string, name: string) => {
  await page.screenshot({
    path: path.join(__dirname, "screenshots", `${width}-${name}.png`),
    animations: "disabled",
    fullPage: name.startsWith("book-"),
  });
};

for (const w of WIDTHS) {
  // covers: AC-15
  test(`admin shots at ${w.name}`, async ({ browser }) => {
    const context = await adminContext(browser, {
      viewport: { width: w.width, height: w.height },
    });
    const page = await context.newPage();

    await page.goto("/admin/testbed-types");
    await expect(
      page.getByRole("heading", { name: "Testbed Types" }),
    ).toBeVisible();
    await shot(page, w.name, "shell-testbed-types");

    if (w.width < 880) {
      await page.getByRole("button", { name: "Open navigation" }).click();
      await expect(page.locator("[data-slot=sheet-content]")).toBeVisible();
      await shot(page, w.name, "drawer-open");
      await page.keyboard.press("Escape");
    }

    await page.goto("/admin/ui-gallery");
    await page.getByRole("button", { name: "Open form modal" }).click();
    await expect(
      page.getByRole("dialog", { name: "Add sample type" }),
    ).toBeVisible();
    await shot(page, w.name, "form-modal");
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Delete Advanced" }).click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await shot(page, w.name, "confirm-dialog");
    await page.getByRole("button", { name: "Cancel" }).click();

    await page.getByRole("button", { name: "Delete Basic" }).click();
    await expect(
      page.getByRole("dialog", { name: "Testbed type in use" }),
    ).toBeVisible();
    await shot(page, w.name, "blocked-dialog");
    await page.getByRole("button", { name: "Got it" }).click();

    await page.getByRole("button", { name: "Show success toast" }).click();
    await expect(page.locator("[data-slot=toast]")).toBeVisible();
    await shot(page, w.name, "toast");

    await context.close();
  });

  // covers: AC-15, spec 0009 AC-10
  test(`public shots at ${w.name}`, async ({ page }) => {
    await page.setViewportSize({ width: w.width, height: w.height });
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(
      page.locator('main img[src*="hol-hero.jpg"]'),
    ).toHaveJSProperty("complete", true);
    await shot(page, w.name, "landing");

    await page.goto(ADMIN_ENTRY);
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await shot(page, w.name, "sign-in-card");
  });

  // covers: spec 0010 AC-14 (bookAction answered by the test)
  test(`/book shots at ${w.name}`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: w.width, height: w.height });
    await walkScreens(page, (screen) => shot(page, w.name, `book-${screen}`));
  });
}
