import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { adminContext, test } from "./admin-session";
import { ADMIN_ENTRY, haveSecrets } from "./authentik";

// Spec 0005 AC-15: the shots /check verify compares with the mock. Dialogs
// and the toast come from the gallery, so they need no shared data. Written
// to e2e/screenshots/ (gitignored).
test.skip(!haveSecrets, "hol-test passwords are not on this machine");

const WIDTHS = [
  { name: "1280", width: 1280, height: 800 },
  { name: "390", width: 390, height: 844 },
] as const;

const shot = (page: Page, width: string, name: string) =>
  page.screenshot({
    path: path.join(__dirname, "screenshots", `${width}-${name}.png`),
    animations: "disabled",
  });

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

  // covers: AC-15
  test(`public shots at ${w.name}`, async ({ page }) => {
    await page.setViewportSize({ width: w.width, height: w.height });
    await page.goto(ADMIN_ENTRY);
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await shot(page, w.name, "sign-in-card");

    await page.goto("/book");
    await expect(
      page.getByRole("heading", { name: "Reserve a remote lab" }),
    ).toBeVisible();
    await shot(page, w.name, "book");
  });
}
