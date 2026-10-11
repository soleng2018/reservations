import { expect, type Locator, type Page } from "@playwright/test";
import { adminContext, test } from "./admin-session";
import { haveSecrets } from "./authentik";

// Feature 9 (spec 0007) in the browser: add, edit, and delete a testbed on
// /admin/testbeds, against the real database and Authentik. Everything it
// makes is named `dev e2e …` and removed again afterwards. Saving a testbed
// creates a real `pod-dev-e2e-…` group; after the delete, the worker removes
// it on its next tick (AC-7), so it stays while no worker runs.
test.skip(!haveSecrets, "hol-test passwords are not on this machine");

const id = () => crypto.randomUUID().slice(0, 8);

const rowOf = (page: Page, name: string) =>
  page.getByRole("row").filter({
    has: page.getByText(name, { exact: true }),
  });

async function choose(
  page: Page,
  scope: Locator,
  label: string,
  option: string,
) {
  await scope.getByRole("combobox", { name: label, exact: true }).click();
  const item = page.getByRole("option", { name: option, exact: true });
  await item.scrollIntoViewIfNeeded();
  await item.click();
}

async function deleteRow(page: Page, path: string, name: string) {
  await page.goto(path);
  const row = rowOf(page, name);
  if ((await row.count()) === 0) return;
  await row.getByRole("button", { name: `Delete ${name}` }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByText("Deleted.")).toBeVisible();
}

const tag = id();
const typeName = `dev e2e type ${tag}`;
const idpName = `dev e2e idp ${tag}`;
const labName = `dev e2e lab ${tag}`;

test.afterAll(async ({ browser }) => {
  const context = await adminContext(browser);
  const page = await context.newPage();
  for (const name of [labName, `${labName} v2`])
    await deleteRow(page, "/admin/testbeds", name);
  await deleteRow(page, "/admin/testbed-types", typeName);
  await deleteRow(page, "/admin/api-keys", idpName);
  await context.close();
});

// covers: AC-1, AC-2, AC-3, AC-6
test("an admin adds a testbed with an IDP and clients, edits it, and deletes it", async ({
  adminPage: page,
}) => {
  test.setTimeout(120_000);

  // An IDP key and a type to choose.
  await page.goto("/admin/api-keys");
  await page.getByRole("button", { name: "Add API key" }).click();
  const keyDialog = page.getByRole("dialog");
  await keyDialog.getByLabel("Name", { exact: true }).fill(idpName);
  await keyDialog.getByLabel("Base URL").fill("https://idp.nile-test.invalid");
  await keyDialog.getByLabel("Key value").fill(`dev-e2e-${tag}`);
  await keyDialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(`Created ${idpName}.`)).toBeVisible();

  await page.goto("/admin/testbed-types");
  await page.getByRole("button", { name: "Add type" }).click();
  const typeDialog = page.getByRole("dialog");
  await typeDialog.getByLabel("Name").fill(typeName);
  await typeDialog.getByLabel("Duration").fill("1");
  await typeDialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(`Created ${typeName}.`)).toBeVisible();

  // AC-2: add, with two clients, one carrying an OS login.
  await page.goto("/admin/testbeds");
  await page.getByRole("button", { name: "Add testbed" }).click();
  const dialog = page.getByRole("dialog", { name: "Add testbed" });
  await dialog.getByLabel("Name", { exact: true }).fill(labName);
  await choose(page, dialog, "Testbed type", typeName);
  await expect(
    dialog.getByRole("combobox", { name: "IDP", exact: true }),
  ).toContainText("None");
  await choose(page, dialog, "IDP", idpName);
  await dialog
    .getByLabel("Nile Portal URL")
    .fill("https://portal.nile-test.invalid");
  await dialog.getByLabel("LMS URL").fill("https://lms.nile-test.invalid");

  await dialog.getByRole("button", { name: "Add client" }).click();
  await dialog.getByRole("button", { name: "Add client" }).click();
  const first = dialog.getByRole("group", { name: "Client 1" });
  const second = dialog.getByRole("group", { name: "Client 2" });
  await expect(
    first.getByRole("combobox", { name: "Kind", exact: true }),
  ).toContainText("Wireless");
  await first.getByLabel("Client name").fill("Air 1");
  await first.getByLabel("Client URL").fill("https://air1.nile-test.invalid");
  await first.getByLabel("OS username").fill("labuser");
  const password = first.getByLabel("OS password", { exact: true });
  await password.fill("first pass");
  await expect(password).toHaveAttribute("type", "password");
  await second.getByLabel("Client name").fill("Wired 1");
  await second
    .getByLabel("Client URL")
    .fill("https://wired1.nile-test.invalid");
  await choose(page, second, "Kind", "Wired");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(`Created ${labName}.`)).toBeVisible({
    timeout: 30_000,
  });

  // AC-1: the mock's columns, found by IDP name in the search.
  await page.getByLabel("Search testbeds").fill(idpName.toUpperCase());
  const row = rowOf(page, labName);
  await expect(row).toContainText(typeName);
  await expect(row).toContainText(idpName);
  await expect(row).toContainText("2 clients");
  await expect(row).not.toContainText("Not ready");
  await page.getByLabel("Search testbeds").fill("");

  // AC-1, AC-3: the list page's HTML (RSC payload included) carries counts
  // only; the OS login reaches the browser through the edit load alone.
  const html = await (await page.request.get("/admin/testbeds")).text();
  expect(html).toContain(labName);
  expect(html).not.toContain("first pass");
  expect(html).not.toContain("labuser");

  // AC-3: edit loads the testbed, OS login included, masked until shown.
  await row.getByRole("button", { name: `Edit ${labName}` }).click();
  const edit = page.getByRole("dialog", { name: "Edit testbed" });
  await expect(edit.getByLabel("Name", { exact: true })).toHaveValue(labName);
  await expect(edit.getByLabel("Access group")).toHaveValue(
    /^pod-dev-e2e-lab-/,
  );
  const editFirst = edit.getByRole("group", { name: "Client 1" });
  await expect(editFirst.getByLabel("OS username")).toHaveValue("labuser");
  const editPassword = editFirst.getByLabel("OS password", { exact: true });
  await expect(editPassword).toHaveValue("first pass");
  await expect(editPassword).toHaveAttribute("type", "password");
  const toggle = editFirst.getByRole("button", {
    name: "Show OS password of client 1",
  });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(editPassword).toHaveAttribute("type", "text");

  await edit.getByLabel("Name", { exact: true }).fill(`${labName} v2`);
  await editPassword.fill("second pass");
  await edit.getByRole("button", { name: "Remove client 2" }).click();
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(`Updated ${labName} v2.`)).toBeVisible();
  await expect(edit).toHaveCount(0);
  const renamed = rowOf(page, `${labName} v2`);
  await expect(renamed).toContainText("1 client");

  // Reopening loads the saved values.
  await renamed.getByRole("button", { name: `Edit ${labName} v2` }).click();
  await expect(
    edit
      .getByRole("group", { name: "Client 1" })
      .getByLabel("OS password", { exact: true }),
  ).toHaveValue("second pass");
  await expect(edit.getByRole("group", { name: "Client 2" })).toHaveCount(0);
  await edit.getByRole("button", { name: "Cancel" }).click();
  await expect(edit).toHaveCount(0);

  // AC-6: no reservations, so the confirm shows, then the row goes.
  await renamed.getByRole("button", { name: `Delete ${labName} v2` }).click();
  await expect(page.getByRole("alertdialog")).toContainText(
    `Delete "${labName} v2"? This can't be undone.`,
  );
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByText("Deleted.")).toBeVisible();
  await expect(renamed).toHaveCount(0);
  await page.reload();
  await expect(rowOf(page, `${labName} v2`)).toHaveCount(0);
});

// covers: AC-2 (the add form's client rules; nothing is written)
test("the add form marks a password without a username, and stops at 20 clients", async ({
  adminPage: page,
}) => {
  await page.goto("/admin/testbeds");
  await page.getByRole("button", { name: "Add testbed" }).click();
  const dialog = page.getByRole("dialog", { name: "Add testbed" });
  const name = `dev e2e refused ${id()}`;
  await dialog.getByLabel("Name", { exact: true }).fill(name);
  await dialog
    .getByLabel("Nile Portal URL")
    .fill("https://portal.nile-test.invalid");
  await dialog.getByLabel("LMS URL").fill("https://lms.nile-test.invalid");
  const addClient = dialog.getByRole("button", { name: "Add client" });
  await addClient.click();
  const first = dialog.getByRole("group", { name: "Client 1" });
  await first.getByLabel("Client name").fill("Air 1");
  await first.getByLabel("Client URL").fill("https://air1.nile-test.invalid");
  await first.getByLabel("OS password", { exact: true }).fill("orphan pass");
  await dialog.getByRole("button", { name: "Save" }).click();

  const username = first.getByLabel("OS username");
  await expect(
    first.getByText("Enter the OS username for this password."),
  ).toBeVisible();
  await expect(username).toHaveAttribute("aria-invalid", "true");
  await expect(username).toHaveAccessibleDescription(
    /Enter the OS username for this password\./,
  );
  // What was typed stays, so the admin only adds the username.
  await expect(first.getByLabel("OS password", { exact: true })).toHaveValue(
    "orphan pass",
  );

  for (let i = 1; i < 20; i++) await addClient.click();
  await expect(dialog.getByRole("group", { name: "Client 20" })).toBeVisible();
  await expect(addClient).toBeDisabled();
  await expect(
    dialog.getByText("A testbed can have at most 20 clients."),
  ).toBeVisible();

  await dialog.getByRole("button", { name: "Cancel" }).click();
  await page.reload();
  await expect(rowOf(page, name)).toHaveCount(0);
});
