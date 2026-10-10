import { expect, type Page } from "@playwright/test";
import { adminContext, test } from "./admin-session";
import { haveSecrets, learner, signIn } from "./authentik";

// Spec 0005 base pieces, driven through the dev gallery's browser fakes, so
// nothing here depends on data in the shared database.
test.skip(!haveSecrets, "hol-test passwords are not on this machine");

const GALLERY = "/admin/ui-gallery";

const toast = (page: Page, text: string) =>
  page.locator("[data-slot=toast-title]", { hasText: text });

async function openGalleryForm(page: Page, outcome: string) {
  await page.getByRole("button", { name: "Open form modal" }).click();
  const dialog = page.getByRole("dialog", { name: "Add sample type" });
  await dialog.getByRole("combobox", { name: "Outcome" }).click();
  await page.getByRole("option", { name: outcome, exact: true }).click();
  await dialog.getByLabel("Name").fill("Gallery sample");
  return dialog;
}

test.describe("form modal", () => {
  // covers: AC-7, AC-9
  test("field errors keep the values and focus the first invalid field", async ({
    adminPage: page,
  }) => {
    await page.goto(GALLERY);
    const dialog = await openGalleryForm(page, "Field errors");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(
      dialog.getByText("A testbed type with this name already exists."),
    ).toBeVisible();
    await expect(dialog.getByLabel("Name")).toHaveValue("Gallery sample");
    await expect(dialog.getByLabel("Name")).toBeFocused();
    await expect(dialog.getByLabel("Name")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
  });

  // covers: AC-7, AC-14 (Escape on a pending save does nothing)
  test("a pending save cannot be dismissed", async ({ adminPage: page }) => {
    await page.goto(GALLERY);
    const dialog = await openGalleryForm(page, "Message error");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog.getByRole("button", { name: /Save/ })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("alert")).toContainText(
      "Couldn't create the testbed's access group",
    );
    await expect(dialog.getByLabel("Name")).toHaveValue("Gallery sample");
  });

  // covers: AC-7
  test("an action that throws unlocks the modal with the generic alert", async ({
    adminPage: page,
  }) => {
    await page.goto(GALLERY);
    const dialog = await openGalleryForm(page, "Throws");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog.getByRole("alert")).toHaveText(
      "Something went wrong. Try again.",
    );
    await expect(dialog.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  // covers: AC-7, AC-9
  test("saved closes the modal, toasts, and reopening starts empty", async ({
    adminPage: page,
  }) => {
    await page.goto(GALLERY);
    const trigger = page.getByRole("button", { name: "Open form modal" });
    const dialog = await openGalleryForm(page, "Saved");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toBeHidden();
    await expect(toast(page, "Created Gallery sample.")).toBeVisible();
    await expect(trigger).toBeFocused();
    await trigger.click();
    await expect(dialog.getByLabel("Name")).toHaveValue("");
    await expect(dialog.getByLabel("Name")).toBeFocused();
  });
});

test.describe("delete flow", () => {
  // covers: AC-8, AC-9
  test("each outcome opens the right dialog or toast", async ({
    adminPage: page,
  }) => {
    await page.goto(GALLERY);
    const del = (label: string) =>
      page.getByRole("button", { name: `Delete ${label}` });
    const confirm = page.getByRole("alertdialog", { name: "Delete this?" });

    await del("Basic").click();
    const blocked = page.getByRole("dialog", { name: "Testbed type in use" });
    await expect(blocked.getByRole("listitem")).toHaveCount(8);
    await expect(confirm).toBeHidden();
    await blocked.getByRole("button", { name: "Got it" }).click();

    await del("Advanced").click();
    await expect(confirm).toContainText(
      `Delete "Advanced"? This can't be undone.`,
    );
    await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
    await confirm.getByRole("button", { name: "Delete" }).click();
    await expect(confirm).toBeHidden();
    await expect(toast(page, "Deleted.")).toBeVisible();

    await del("Okta Production").click();
    await confirm.getByRole("button", { name: "Delete" }).click();
    await expect(
      page.getByRole("dialog", { name: "API key in use" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Got it" }).click();

    await del("Nile Workshop 3").click();
    await confirm.getByRole("button", { name: "Delete" }).click();
    await expect(
      toast(page, "Couldn't remove the testbed's access group. Try again."),
    ).toBeVisible();

    await del("Expert").click();
    await expect(
      toast(page, "Couldn't check whether this can be deleted. Try again."),
    ).toBeVisible();

    await del("Bench 10").click();
    await confirm.getByRole("button", { name: "Delete" }).click();
    await expect(confirm).toBeHidden();
    await expect(
      toast(page, "Something went wrong. Try again.").first(),
    ).toBeVisible();
  });
});

test.describe("keyboard", () => {
  // covers: AC-14
  test("Tab reaches the skip link first on learner and admin pages", async ({
    adminPage,
    page,
  }) => {
    await page.goto("/book");
    await page.keyboard.press("Tab");
    await expect(
      page.getByRole("link", { name: "Skip to content" }),
    ).toBeFocused();

    await adminPage.goto("/admin/testbed-types");
    await adminPage.keyboard.press("Tab");
    await expect(
      adminPage.getByRole("link", { name: "Skip to content" }),
    ).toBeFocused();
  });

  // covers: AC-4, AC-14
  test("the mobile drawer traps focus and Escape returns it to the menu button", async ({
    browser,
  }) => {
    const context = await adminContext(browser, {
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();
    await page.goto("/admin/testbed-types");
    const menu = page.getByRole("button", { name: "Open navigation" });
    await menu.focus();
    await page.keyboard.press("Enter");
    const drawer = page.locator("[data-slot=sheet-content]");
    await expect(drawer).toBeVisible();
    // The open drawer hides the page from the accessibility tree, so the
    // button's state is read by CSS, not by role.
    await expect(
      page.locator('button[aria-label="Open navigation"]'),
    ).toHaveAttribute("aria-expanded", "true");
    // Four links and Sign out, then focus wraps inside the drawer.
    for (let i = 0; i < 7; i++) {
      await page.keyboard.press("Tab");
      expect(
        await drawer.evaluate((el) => el.contains(document.activeElement)),
      ).toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(menu).toBeFocused();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
    await context.close();
  });
});

// covers: AC-5, AC-13
test("a learner gets today's refusal on admin pages, with no shell", async ({
  page,
}) => {
  await signIn(page, "/reservations", learner);
  await expect(page).toHaveURL(/\/reservations$/);
  for (const path of ["/admin/testbeds", GALLERY]) {
    await page.goto(path);
    await expect(page).toHaveURL(/reason=not_authorized/);
    await expect(page.getByRole("navigation", { name: "Admin" })).toHaveCount(
      0,
    );
  }
});

// covers: AC-2
test("the booking page makes no request to Google's font hosts", async ({
  page,
}) => {
  const hosts: string[] = [];
  page.on("request", (r) => hosts.push(new URL(r.url()).host));
  await page.goto("/book");
  await expect(
    page.getByRole("heading", { name: "Reserve a remote lab" }),
  ).toBeVisible();
  expect(
    hosts.filter((h) => /fonts\.(googleapis|gstatic)\.com$/.test(h)),
  ).toEqual([]);
});
