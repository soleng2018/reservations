import { expect } from "@playwright/test";
import { test } from "./admin-session";
import { haveSecrets } from "./authentik";

// Spec 0017 AC-14, AC-16 to AC-18 in the browser: the add dialog lists the
// owner's marked groups and Save stays off until the list has loaded.
test.skip(!haveSecrets, "hol-test passwords are not on this machine");

test("add dialog offers marked groups in a select", async ({
  adminPage: page,
}) => {
  await page.goto("/admin/testbeds");
  await page.getByRole("button", { name: "Add testbed" }).click();
  const dialog = page.getByRole("dialog");
  const group = dialog.getByRole("combobox", { name: /group name/i });
  await expect(group).toBeVisible({ timeout: 20_000 });
  await page.screenshot({
    path: "e2e/screenshots/testbed-add-dialog.png",
  });
  // No free text group field.
  await expect(
    dialog.getByRole("textbox", { name: /group name/i }),
  ).toHaveCount(0);
  await group.click();
  const options = page.getByRole("option");
  const names = await options.allInnerTexts();
  expect(names.length).toBeGreaterThan(0);
  expect(names).toEqual(
    [...names].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())),
  );
  // Spec 0017 AC-20: Domain is read only, and empty before a choice.
  const domain = dialog.getByRole("textbox", { name: "Domain" });
  await expect(domain).toHaveAttribute("readonly", "");
  await expect(domain).toHaveValue("");
  const enabled = options.filter({ hasNotText: "(no domain set)" });
  await enabled.first().click();
  await expect(domain).not.toHaveValue("");
});
