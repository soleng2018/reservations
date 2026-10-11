import { expect, type Page } from "@playwright/test";
import { z } from "zod";
import { test } from "./admin-session";
import { authentikGet, haveApi, haveSecrets, results } from "./authentik";

// Feature 10 (spec 0008) in the browser, against the real database and
// Authentik: add a learner, find them, open their page, edit them, then
// deactivate and reactivate. There is no delete, so each run leaves one
// deactivated `dev-learner-…@nile-test.invalid` learner (and its inactive
// Authentik account) behind, by design.
test.skip(!haveSecrets, "hol-test passwords are not on this machine");

const run = crypto.randomUUID().slice(0, 8);
const name = `Dev Learner ${run}`;
const email = `dev-learner-${run}@nile-test.invalid`;

// The Authentik account's active flag, through the read only API helper.
const authentikActive = async () => {
  const found = await authentikGet(
    results(z.looseObject({ is_active: z.boolean() })),
    `/core/users/?username=${encodeURIComponent(email)}`,
  );
  expect(found.results).toHaveLength(1);
  return found.results[0]?.is_active;
};

async function chooseZone(page: Page, zone: string) {
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox", { name: "Timezone", exact: true }).click();
  const item = page.getByRole("option", { name: zone, exact: true });
  await item.scrollIntoViewIfNeeded();
  await item.click();
}

// covers: AC-1, AC-2, AC-4, AC-6, AC-8, AC-9
test("an admin adds, finds, edits, deactivates, and reactivates a learner", async ({
  adminPage: page,
}) => {
  test.setTimeout(120_000);

  // AC-4: add.
  await page.goto("/admin/users");
  await expect(
    page.getByRole("heading", { level: 1, name: "Users" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Add user" }).click();
  const add = page.getByRole("dialog");
  await expect(add.getByRole("heading", { name: "Add User" })).toBeVisible();
  await add.getByLabel("Full name").fill(name);
  await add.getByLabel("Company name").fill("Nile e2e");
  await add.getByLabel("Email address").fill(email);
  await chooseZone(page, "America/Toronto");
  await add.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(`Added ${name}.`)).toBeVisible({
    timeout: 30_000,
  });

  // AC-1: listed, and found by search.
  await page
    .getByRole("searchbox", { name: "Search users" })
    .fill(`dev-learner-${run}`);
  const row = page.getByRole("row").filter({ hasText: email });
  await expect(row).toHaveCount(1);
  await expect(row.getByText("0 reservations")).toBeVisible();
  await expect(row.getByText("Active", { exact: true })).toBeVisible();

  // AC-2: the detail page.
  await row.getByRole("link", { name: `View ${name}` }).click();
  await expect(page).toHaveURL(/\/admin\/users\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
  await expect(page.getByText("No reservations yet.")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Resend set password email" }),
  ).toBeVisible();

  // AC-6: edit company and timezone; the email stays editable until the
  // learner signs in, so it is left as is.
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const edit = page.getByRole("dialog");
  await expect(edit.getByLabel("Full name")).toHaveValue(name);
  await edit.getByLabel("Company name").fill("Nile e2e edited");
  await chooseZone(page, "Europe/Paris");
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(`Updated ${name}.`)).toBeVisible();
  await expect(
    page.getByText(`Nile e2e edited · ${email}`).first(),
  ).toBeVisible();

  // AC-8: deactivate, with nothing to cancel.
  await page.getByRole("button", { name: "Deactivate user" }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm.getByText(`Deactivate ${name}?`)).toBeVisible();
  await expect(
    confirm.getByText("These reservations will be cancelled:"),
  ).toHaveCount(0);
  await confirm
    .getByRole("button", { name: "Deactivate", exact: true })
    .click();
  await expect(page.getByText(`Deactivated ${name}.`)).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText("Deactivated", { exact: true })).toBeVisible();
  if (haveApi) expect(await authentikActive()).toBe(false);

  // AC-9: reactivate, then deactivate again so the run leaves it inactive.
  await page.getByRole("button", { name: "Reactivate user" }).click();
  await expect(page.getByText(`Reactivated ${name}.`)).toBeVisible({
    timeout: 30_000,
  });
  if (haveApi) expect(await authentikActive()).toBe(true);

  await page.getByRole("button", { name: "Deactivate user" }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Deactivate", exact: true })
    .click();
  await expect(page.getByText(`Deactivated ${name}.`)).toBeVisible({
    timeout: 30_000,
  });
});
