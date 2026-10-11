import { expect, type Page } from "@playwright/test";
import { adminContext, test } from "./admin-session";
import { haveSecrets } from "./authentik";

// Feature 7 in the browser: add, edit, and delete testbed types on
// /admin/testbed-types, against the real database. Each test removes the
// types it created (names start with `e2e types `), even when it fails.
test.skip(!haveSecrets, "hol-test passwords are not on this machine");

const unique = () => crypto.randomUUID().slice(0, 8);

const rowOf = (page: Page, name: string) =>
  page.getByRole("row").filter({
    has: page.getByRole("cell", { name, exact: true }),
  });

async function addType(page: Page, name: string, duration = "1") {
  await page.getByRole("button", { name: "Add type" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill(name);
  await dialog.getByLabel("Duration").fill(duration);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(`Created ${name}.`)).toBeVisible();
}

async function deleteType(page: Page, name: string) {
  await rowOf(page, name)
    .getByRole("button", { name: `Delete ${name}` })
    .click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByText("Deleted.")).toBeVisible();
}

// Names this test created, deleted again in afterEach if still listed.
let created: string[] = [];

test.beforeEach(() => {
  created = [];
});

test.afterEach(async ({ adminPage: page }) => {
  await page.goto("/admin/testbed-types");
  for (const name of created)
    if ((await rowOf(page, name).count()) > 0) await deleteType(page, name);
});

test("an admin adds a type, edits it, and deletes it", async ({
  adminPage: page,
}) => {
  const name = `e2e types ${unique()}`;
  created.push(name, `${name} v2`);
  await page.goto("/admin/testbed-types");

  await addType(page, name, "4");
  await expect(rowOf(page, name)).toContainText("4 hours");
  await expect(rowOf(page, name)).toContainText("0 testbeds");

  // The edit dialog opens with the row's values and focus on the name.
  await rowOf(page, name)
    .getByRole("button", { name: `Edit ${name}` })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading")).toHaveText("Edit testbed type");
  await expect(dialog.getByLabel("Name")).toBeFocused();
  await expect(dialog.getByLabel("Name")).toHaveValue(name);
  await expect(dialog.getByLabel("Duration")).toHaveValue("4");
  await expect(dialog.getByRole("combobox", { name: "Unit" })).toContainText(
    "Hours",
  );

  await dialog.getByLabel("Name").fill(`${name} v2`);
  await dialog.getByLabel("Duration").fill("2");
  await dialog.getByRole("combobox", { name: "Unit" }).click();
  await page.getByRole("option", { name: "Days", exact: true }).click();
  await dialog.getByRole("button", { name: "Save" }).click();

  await expect(page.getByText(`Updated ${name} v2.`)).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await expect(rowOf(page, `${name} v2`)).toContainText("2 days");

  // Reopening shows the saved values, not the ones from before.
  await rowOf(page, `${name} v2`)
    .getByRole("button", { name: `Edit ${name} v2` })
    .click();
  await expect(dialog.getByLabel("Name")).toHaveValue(`${name} v2`);
  await expect(dialog.getByLabel("Duration")).toHaveValue("2");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);

  // Delete asks first, with Cancel focused, then removes the row.
  await rowOf(page, `${name} v2`)
    .getByRole("button", { name: `Delete ${name} v2` })
    .click();
  await expect(page.getByRole("alertdialog")).toContainText(
    `Delete "${name} v2"? This can't be undone.`,
  );
  await expect(page.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByText("Deleted.")).toBeVisible();
  await expect(rowOf(page, `${name} v2`)).toHaveCount(0);

  await page.reload();
  await expect(rowOf(page, `${name} v2`)).toHaveCount(0);
});

test("an edit to a taken name or a zero duration shows field errors and keeps the dialog open", async ({
  adminPage: page,
}) => {
  const first = `e2e types ${unique()}`;
  const second = `e2e types ${unique()}`;
  created.push(first, second);
  await page.goto("/admin/testbed-types");
  await addType(page, first);
  await addType(page, second);

  await rowOf(page, second)
    .getByRole("button", { name: `Edit ${second}` })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill(first.toUpperCase());
  await dialog.getByLabel("Duration").fill("0");
  await dialog.getByRole("button", { name: "Save" }).click();

  await expect(dialog.getByText("Use at least 1.")).toBeVisible();
  await dialog.getByLabel("Duration").fill("1");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(
    dialog.getByText("A testbed type with this name already exists."),
  ).toBeVisible();
  await expect(dialog.getByLabel("Name")).toHaveAttribute(
    "aria-invalid",
    "true",
  );

  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(rowOf(page, second)).toHaveCount(1);
});

test("at 390px the row actions are reachable and the page does not scroll sideways", async ({
  browser,
}) => {
  const context = await adminContext(browser, {
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  const name = `e2e types ${unique()}`;
  created.push(name);
  try {
    await page.goto("/admin/testbed-types");
    await addType(page, name);

    const edit = rowOf(page, name).getByRole("button", {
      name: `Edit ${name}`,
    });
    await edit.scrollIntoViewIfNeeded();
    await edit.click();
    await expect(page.getByRole("dialog").getByLabel("Name")).toHaveValue(name);
    await page.keyboard.press("Escape");
    await expect(edit).toBeFocused();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
  } finally {
    await context.close();
  }
});
