import { expect, type Locator, type Page } from "@playwright/test";
import { adminContext, test } from "./admin-session";
import {
  haveProvisioning,
  haveSecrets,
  makeTestbedGroup,
  removeGroup,
} from "./authentik";

// Feature 9 (spec 0007) and feature 19 (spec 0017) in the browser: add, edit,
// and delete a testbed on /admin/testbeds, against the real database and
// Authentik. A testbed is named like an Authentik group the owner made, so the
// test makes its own throwaway groups (`dev-e2e-…`, one marked for testbeds
// and one not) with the provisioning token and removes them afterwards. The
// app itself never creates or deletes a group. Everything else it makes is
// named `dev e2e …` and removed again.
test.skip(
  !haveSecrets || !haveProvisioning,
  "hol-test passwords or the provisioning token are not on this machine",
);

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
// The testbed's group name is its Authentik group's name, its name is what
// learners see (spec 0018), and its domain is its Nile tenant's.
const labName = `dev-e2e-lab-${tag}`;
const friendly = `Friendly Lab ${tag}`;
const renamedTo = `Renamed Lab ${tag}`;
const plainName = `dev-e2e-plain-${tag}`;
const labDomain = `dev-e2e-${tag}.nile-test.invalid`;
const movedDomain = `dev-e2e-${tag}-v2.nile-test.invalid`;
const groupPks: string[] = [];

test.beforeAll(async () => {
  groupPks.push(await makeTestbedGroup(labName, true));
  groupPks.push(await makeTestbedGroup(plainName, false));
});

test.afterAll(async ({ browser }) => {
  const context = await adminContext(browser);
  const page = await context.newPage();
  await deleteRow(page, "/admin/testbeds", renamedTo);
  await deleteRow(page, "/admin/testbeds", friendly);
  await deleteRow(page, "/admin/testbed-types", typeName);
  await deleteRow(page, "/admin/api-keys", idpName);
  await context.close();
  // The worker lets the deleted testbed's group go as `gone` on its next tick.
  for (const pk of groupPks) await removeGroup(pk);
});

// covers: AC-1, AC-2, AC-3, AC-6, spec 0017 AC-1, AC-3, AC-5, AC-6, AC-8
test("an admin adds a testbed with a domain, an IDP and clients, edits it, and deletes it", async ({
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
  await expect(
    dialog.getByText(
      "Must be the exact name of an Authentik group the owner has set up for this lab.",
    ),
  ).toBeVisible();
  await dialog.getByLabel("Name", { exact: true }).fill(friendly);
  await dialog.getByLabel("Group Name", { exact: true }).fill(labName);
  await dialog.getByLabel("Domain", { exact: true }).fill(labDomain);
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
  await expect(page.getByText(`Created ${friendly}.`)).toBeVisible({
    timeout: 30_000,
  });

  // AC-1, spec 0017 AC-8: the columns, found by IDP name and by domain.
  await page.getByLabel("Search testbeds").fill(idpName.toUpperCase());
  const row = rowOf(page, friendly);
  await expect(row).toContainText(labName);
  await expect(row).toContainText(typeName);
  await expect(row).toContainText(labDomain);
  await expect(row).toContainText(idpName);
  await expect(row).toContainText("2 clients");
  await expect(row).not.toContainText("Not ready");
  await page.getByLabel("Search testbeds").fill(labDomain.toUpperCase());
  await expect(row).toBeVisible();
  await page.getByLabel("Search testbeds").fill("");

  // AC-1, AC-3: the list page's HTML (RSC payload included) carries counts
  // only; the OS login reaches the browser through the edit load alone.
  const html = await (await page.request.get("/admin/testbeds")).text();
  expect(html).toContain(labName);
  expect(html).not.toContain("first pass");
  expect(html).not.toContain("labuser");

  // AC-3, spec 0017 AC-5: edit loads the testbed, OS login included, masked
  // until shown. The group name is read only, the name can change (spec 0018 AC-2, AC-4).
  await row.getByRole("button", { name: `Edit ${friendly}` }).click();
  const edit = page.getByRole("dialog", { name: "Edit testbed" });
  const nameField = edit.getByLabel("Name", { exact: true });
  await expect(nameField).toHaveValue(friendly);
  await expect(nameField).not.toHaveAttribute("readonly", "");
  const groupField = edit.getByLabel("Group Name", { exact: true });
  await expect(groupField).toHaveValue(labName);
  await expect(groupField).toHaveAttribute("readonly", "");
  await expect(
    edit.getByText(
      "The group name can't change. To use another group, delete this testbed and add a new one.",
    ),
  ).toBeVisible();
  await expect(edit.getByLabel("Domain", { exact: true })).toHaveValue(
    labDomain,
  );
  await expect(edit.getByLabel("Access group")).toHaveCount(0);
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

  // Spec 0017 AC-6: no reservation, so the domain can change.
  await edit.getByLabel("Domain", { exact: true }).fill(movedDomain);
  await editPassword.fill("second pass");
  await nameField.fill(renamedTo);
  await edit.getByRole("button", { name: "Remove client 2" }).click();
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(`Updated ${renamedTo}.`)).toBeVisible();
  await expect(edit).toHaveCount(0);
  const renamed = rowOf(page, renamedTo);
  await expect(renamed).toContainText(labName);
  await expect(renamed).toContainText("1 client");
  await expect(renamed).toContainText(movedDomain);

  // Reopening loads the saved values.
  await renamed.getByRole("button", { name: `Edit ${renamedTo}` }).click();
  await expect(edit.getByLabel("Domain", { exact: true })).toHaveValue(
    movedDomain,
  );
  await expect(
    edit
      .getByRole("group", { name: "Client 1" })
      .getByLabel("OS password", { exact: true }),
  ).toHaveValue("second pass");
  await expect(edit.getByRole("group", { name: "Client 2" })).toHaveCount(0);
  await edit.getByRole("button", { name: "Cancel" }).click();
  await expect(edit).toHaveCount(0);

  // AC-6: no reservations, so the confirm shows, then the row goes.
  await renamed.getByRole("button", { name: `Delete ${renamedTo}` }).click();
  await expect(page.getByRole("alertdialog")).toContainText(
    `Delete "${renamedTo}"? This can't be undone.`,
  );
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByText("Deleted.")).toBeVisible();
  await expect(renamed).toHaveCount(0);
  await page.reload();
  await expect(rowOf(page, renamedTo)).toHaveCount(0);
});

// covers: spec 0017 AC-2, AC-3 (the add form checks the name and the group;
// nothing is written)
test("the add form refuses a name that is no usable Authentik group", async ({
  adminPage: page,
}) => {
  await page.goto("/admin/testbeds");
  await page.getByRole("button", { name: "Add testbed" }).click();
  const dialog = page.getByRole("dialog", { name: "Add testbed" });
  const typeRow = dialog.getByRole("combobox", {
    name: "Testbed type",
    exact: true,
  });
  await typeRow.click();
  await page.getByRole("option").first().click();
  await dialog
    .getByLabel("Nile Portal URL")
    .fill("https://portal.nile-test.invalid");
  await dialog.getByLabel("LMS URL").fill("https://lms.nile-test.invalid");
  await dialog
    .getByLabel("Domain", { exact: true })
    .fill(`dev-e2e-${id()}.nile-test.invalid`);

  await dialog
    .getByLabel("Name", { exact: true })
    .fill(`Plain friendly ${id()}`);
  const name = dialog.getByLabel("Group Name", { exact: true });
  const save = dialog.getByRole("button", { name: "Save" });

  await name.fill(`dev-e2e-nothing-${id()}`);
  await save.click();
  await expect(
    dialog.getByText("No Authentik group with this group name exists."),
  ).toBeVisible();

  await name.fill(plainName);
  await save.click();
  await expect(
    dialog.getByText(
      "That group isn't set up for testbeds. It needs the hol_testbed_group marker.",
    ),
  ).toBeVisible();

  await dialog.getByRole("button", { name: "Cancel" }).click();
  await page.reload();
  await expect(rowOf(page, plainName)).toHaveCount(0);
});

// covers: AC-2 (the add form's client rules; nothing is written)
test("the add form marks a password without a username, and stops at 20 clients", async ({
  adminPage: page,
}) => {
  await page.goto("/admin/testbeds");
  await page.getByRole("button", { name: "Add testbed" }).click();
  const dialog = page.getByRole("dialog", { name: "Add testbed" });
  const name = `dev-e2e-refused-${id()}`;
  await dialog.getByLabel("Name", { exact: true }).fill(name);
  await dialog
    .getByLabel("Domain", { exact: true })
    .fill(`dev-e2e-${id()}.nile-test.invalid`);
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
