import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { adminContext, test } from "./admin-session";
import { haveSecrets } from "./authentik";
import { expectNoSeriousViolations } from "./axe";

// Spec 0016 AC-16: the Audit Log in the browser, against the real database.
// The test removes the type it created (names start with `e2e audit `);
// its audit entries stay, since the log is append only.
test.skip(!haveSecrets, "hol-test passwords are not on this machine");

const unique = () => crypto.randomUUID().slice(0, 8);
const ADMIN_NAME = "HOL Test Admin";

const typeRow = (page: Page, name: string) =>
  page.getByRole("row").filter({
    has: page.getByRole("cell", { name, exact: true }),
  });

// The log's entry rows (the hidden detail rows are not in the role tree).
const entries = (page: Page) =>
  page.getByRole("region", { name: "Audit entries" }).getByRole("row");

let created: string | undefined;

test.afterEach(async ({ adminPage: page }) => {
  if (!created) return;
  await page.goto("/admin/testbed-types");
  const row = typeRow(page, created);
  if ((await row.count()) > 0) {
    await row.getByRole("button", { name: `Delete ${created}` }).click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByText("Deleted.")).toBeVisible();
  }
  created = undefined;
});

// covers: AC-1, AC-2, AC-3, AC-4, AC-5, AC-7, AC-8, AC-9, AC-16
test("an admin edits a type, then reads, filters, and pages the log", async ({
  adminPage: page,
}) => {
  test.setTimeout(120_000);
  const name = `e2e audit ${unique()}`;
  created = name;
  await page.goto("/admin/testbed-types");
  await page.getByRole("button", { name: "Add type" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill(name);
  await dialog.getByLabel("Duration").fill("2");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(`Created ${name}.`)).toBeVisible();

  await typeRow(page, name)
    .getByRole("button", { name: `Edit ${name}` })
    .click();
  await dialog.getByLabel("Duration").fill("3");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(`Updated ${name}.`)).toBeVisible();

  // The edit is the newest entry, with the admin's name and the type.
  await page.getByRole("link", { name: "Audit Log" }).click();
  await expect(page.getByRole("heading", { name: "Audit Log" })).toBeVisible();
  const top = entries(page).nth(1);
  await expect(top).toContainText(ADMIN_NAME);
  await expect(top).toContainText("Testbed type updated");
  await expect(top).toContainText(name);

  // Expanding it shows the changed duration.
  const details = top.getByRole("button", { name: /^Details for/ });
  await details.click();
  await expect(details).toHaveAttribute("aria-expanded", "true");
  const panel = page.locator(
    `[id="${await details.getAttribute("aria-controls")}"]`,
  );
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Duration value");
  await expect(panel).toContainText("2 → 3");

  // Filter by area, then by free text: only this type's two entries.
  await page.getByLabel("Area").selectOption("testbed_types");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page).toHaveURL(/area=testbed_types/);
  await expect(entries(page).nth(1)).toContainText(name);
  await page.getByLabel("Search").fill(name);
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page).toHaveURL(/q=e2e\+audit/);
  await expect(entries(page)).toHaveCount(3);
  await expect(entries(page).nth(1)).toContainText("Testbed type updated");
  await expect(entries(page).nth(2)).toContainText("Testbed type created");

  // The type's History link opens its history, with a removable chip.
  await page.goto("/admin/testbed-types");
  await page.getByRole("link", { name: `History for ${name}` }).click();
  await expect(page).toHaveURL(/target=testbed_type%3A/);
  await expect(page.getByText(`History for ${name}`)).toBeVisible();
  await expect(entries(page)).toHaveCount(3);
  await page
    .getByRole("link", { name: `Remove filter: History for ${name}` })
    .click();
  await expect(page).toHaveURL(/\/admin\/audit-log$/);

  // Older, then Newer, by keyset cursor.
  await page.getByRole("link", { name: "Older" }).click();
  await expect(page).toHaveURL(/before=/);
  await expect(page.getByRole("link", { name: "Newer" })).toBeVisible();
  await page.getByRole("link", { name: "Newer" }).click();
  await expect(page).toHaveURL(/after=/);
  await expect(page.getByRole("link", { name: "Older" })).toBeVisible();
  await expect(entries(page).nth(1)).toBeVisible();
});

// covers: AC-14
test("a bad link shows the page with one notice, never an error", async ({
  adminPage: page,
}) => {
  await page.goto(
    "/admin/audit-log?admin=nope&from=2026-10-21&to=2026-10-20&q=a&before=forged&after=forged",
  );
  await expect(page.getByRole("heading", { name: "Audit Log" })).toBeVisible();
  await expect(
    page.getByText("Some filters in this link weren't valid and were ignored."),
  ).toBeVisible();
  await expect(entries(page).nth(1)).toBeVisible();
});

// Every table on the page has one header per cell of its first shown row, so
// no heading sits over another column's data (axe does not check this).
async function expectAlignedTables(page: Page) {
  const shapes = await page.locator("table").evaluateAll((tables) =>
    tables.map((t) => ({
      region: t.closest("[role=region]")?.getAttribute("aria-label") ?? "",
      headers: t.querySelectorAll("thead th").length,
      cells: t.querySelector("tbody tr:not([hidden])")?.children.length ?? 0,
    })),
  );
  expect(shapes.length).toBeGreaterThan(0);
  for (const s of shapes.filter((s) => s.cells > 0)) {
    expect(s.cells, `${s.region} table`).toBe(s.headers);
  }
}

// The first learner on Users who has an entry in their History section.
async function learnerWithHistory(page: Page) {
  await page.goto("/admin/users");
  await page
    .getByRole("link", { name: /^View / })
    .first()
    .click();
  await expect(page.getByRole("heading", { name: "History" })).toBeVisible();
}

// covers: AC-10, AC-16
test("axe finds no serious violation on the log and the History section", async ({
  adminPage: page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/admin/audit-log?area=bookings");
  await entries(page)
    .nth(1)
    .getByRole("button", { name: /^Details for/ })
    .click();
  await expectNoSeriousViolations(page);
  await expectAlignedTables(page);

  await learnerWithHistory(page);
  await expect(page.getByRole("link", { name: "See all" })).toHaveAttribute(
    "href",
    /\/admin\/audit-log\?learner=/,
  );
  await expectNoSeriousViolations(page);
  await expectAlignedTables(page);
});

for (const w of [
  { name: "1280", width: 1280, height: 800 },
  { name: "390", width: 390, height: 844 },
] as const) {
  // covers: AC-16
  test(`audit log shots at ${w.name}`, async ({ browser }) => {
    const context = await adminContext(browser, {
      viewport: { width: w.width, height: w.height },
    });
    const page = await context.newPage();
    const shot = (file: string) =>
      page.screenshot({
        path: path.join(__dirname, "screenshots", `${w.name}-${file}.png`),
        animations: "disabled",
        fullPage: true,
      });

    await page.goto("/admin/audit-log");
    await expect(entries(page).nth(1)).toBeVisible();
    await shot("audit-log");
    await page.goto("/admin/audit-log?area=bookings");
    await entries(page)
      .nth(1)
      .getByRole("button", { name: /^Details for/ })
      .click();
    await shot("audit-log-details");
    await learnerWithHistory(page);
    await shot("user-history");
    await context.close();
  });
}
