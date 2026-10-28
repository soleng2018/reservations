import { expect, type Page } from "@playwright/test";
import { test } from "./admin-session";
import { haveSecrets } from "./authentik";
import { expectNoSeriousViolations } from "./axe";

// Spec 0022 (tasks 1 to 6): the read only Nile Portal Reset page against the
// real database. Reads only, so it changes nothing.
test.skip(!haveSecrets, "hol-test passwords are not on this machine");

// covers: AC-3, AC-4, AC-10, AC-20, AC-21, AC-24
test("the page opens read only with the 13 starting steps in order", async ({
  adminPage: page,
}) => {
  await page.goto("/admin/nile-portal-reset");
  await expect(
    page.getByRole("heading", { name: "Nile Portal Reset", level: 1 }),
  ).toBeVisible();

  const steps = page.getByRole("list", { name: /Reset steps/ }).locator("> li");
  await expect(steps).toHaveCount(13);
  await expect(steps.first()).toContainText("Integrations");
  await expect(steps.nth(1)).toContainText("SSIDs");
  await expect(steps.nth(1)).toContainText(
    "skipping items where ssid.popTunnelUsed is true",
  );
  await expect(steps.nth(1)).toContainText(
    "SSIDs where ssid.popTunnelUsed is true are never deleted.",
  );
  await expect(steps.nth(5)).toContainText("Service Profiles");
  await expect(steps.nth(5)).toContainText("Disabled");
  await expect(page.getByText("Disabled", { exact: true })).toHaveCount(1);

  await expect(
    page.getByText("Aborted resets will not be emailed."),
  ).toBeVisible();
  await expect(page.getByText("Off", { exact: true })).toBeVisible();

  // No controls to edit anything in the content area.
  const main = page.getByRole("main");
  await expect(main.getByRole("button")).toHaveCount(0);
  await expect(main.getByRole("textbox")).toHaveCount(0);
  await page.screenshot({
    path: "test-results/nile-portal-reset-wide.png",
    fullPage: true,
  });
});

test("the nav lists the page between Users and Audit Log", async ({
  adminPage: page,
}) => {
  await page.goto("/admin/nile-portal-reset");
  const nav = page.getByRole("navigation").first();
  const labels = await nav.getByRole("link").allInnerTexts();
  const clean = labels.map((l) => l.trim());
  expect(clean.indexOf("Nile Portal Reset")).toBe(clean.indexOf("Users") + 1);
  expect(clean.indexOf("Audit Log")).toBe(
    clean.indexOf("Nile Portal Reset") + 1,
  );
  await page.getByRole("link", { name: "History" }).click();
  await expect(page).toHaveURL(/\/admin\/audit-log\?area=portal_reset/);
});

// covers: AC-15
test("at 390px each step is a card and the page does not scroll sideways", async ({
  adminPage: page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/admin/nile-portal-reset");
  await expect(page.getByRole("list", { name: /Reset steps/ })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({
    path: "test-results/nile-portal-reset-narrow.png",
    fullPage: true,
  });
});

test("has no serious accessibility violations", async ({ adminPage: page }) => {
  await page.goto("/admin/nile-portal-reset");
  await expect(page.getByRole("list", { name: /Reset steps/ })).toBeVisible();
  await expectNoSeriousViolations(page);
});

// Spec 0022 tasks 7 to 9: edit mode, drag by keyboard, Save. The database is
// shared with the running app, so the one test that saves puts the order back
// and saves again (mode and email are never touched).
const stepNames = (page: Page) =>
  page
    .getByRole("list", { name: /Reset steps/ })
    .locator("> li")
    .evaluateAll((items) =>
      items.map(
        (li) =>
          li.querySelector("[data-testid=step-number]")?.nextElementSibling
            ?.firstElementChild?.textContent ?? "",
      ),
    );

const startEditing = async (page: Page) => {
  await page.goto("/admin/nile-portal-reset");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Edit", exact: true })
    .click();
  await expect(page.getByRole("button", { name: "Save" })).toBeVisible();
};

// dnd-kit attaches its key listener a tick after the lift, so each key waits
// for the sign that the one before it was taken.
const keyboardMove = async (page: Page, name: string, key: string) => {
  const handle = page.getByRole("button", {
    name: new RegExp(`^Reorder ${name},`),
  });
  await handle.focus();
  await page.keyboard.press("Space");
  await expect(handle).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press(key);
  await expect(
    page.locator("[aria-live]").filter({ hasText: /moved to position/ }),
  ).toBeAttached();
  await page.waitForTimeout(150);
  await page.keyboard.press("Space");
  await expect(
    page.locator("[aria-live]").filter({ hasText: /dropped at position/ }),
  ).toBeAttached();
  // Focus stays on the handle after a drop (spec 0022 UX surface).
  await expect(
    page.getByRole("button", { name: new RegExp(`^Reorder ${name},`) }),
  ).toBeFocused();
};

// covers: AC-5
test("Cancel on the Edit confirm changes nothing; Confirm shows the edit controls", async ({
  adminPage: page,
}) => {
  await page.goto("/admin/nile-portal-reset");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Cancel" })
    .click();
  await expect(page.getByRole("alertdialog")).toBeHidden();
  await expect(page.getByRole("button", { name: /^Reorder/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);

  await startEditing(page);
  await expect(page.getByRole("button", { name: /^Reorder/ })).toHaveCount(13);
  await expect(page.getByRole("button", { name: "Add row" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Discard" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Edit / })).toHaveCount(13);
  await expect(page.getByRole("button", { name: /^Remove / })).toHaveCount(13);
  await expectNoSeriousViolations(page);
  await page.getByRole("button", { name: "Discard" }).click();
  await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);
});

// covers: AC-8, AC-6
test("a row moves by keyboard, is announced, renumbers, and Escape cancels", async ({
  adminPage: page,
}) => {
  await startEditing(page);
  const before = await stepNames(page);
  expect(before[1]).toBe("SSIDs");

  const handle = page.getByRole("button", { name: /^Reorder SSIDs,/ });
  await expect(handle).toHaveAccessibleName("Reorder SSIDs, position 2 of 13");
  await handle.focus();
  await page.keyboard.press("Space");
  // The lift is announced, then at once as over its own place.
  await expect(handle).toHaveAttribute("aria-pressed", "true");
  await expect(
    page
      .locator("[aria-live]")
      .filter({ hasText: "SSIDs moved to position 2 of 13." }),
  ).toBeAttached();
  await page.keyboard.press("ArrowDown");
  await expect(
    page
      .locator("[aria-live]")
      .filter({ hasText: "SSIDs moved to position 3 of 13." }),
  ).toBeAttached();
  await page.keyboard.press("Escape");
  expect(await stepNames(page)).toEqual(before);

  await keyboardMove(page, "SSIDs", "ArrowDown");
  const after = await stepNames(page);
  expect(after[2]).toBe("SSIDs");
  expect(after[1]).toBe(before[2]);
  const numbers = await page.getByTestId("step-number").allInnerTexts();
  expect(numbers.map((n) => n.replace("Step", "").trim())).toEqual(
    Array.from({ length: 13 }, (_, i) => String(i + 1)),
  );

  // A changed draft asks before it is thrown away.
  await page.getByRole("button", { name: "Discard" }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Discard" })
    .click();
  expect(await stepNames(page)).toEqual(before);
});

// covers: AC-13
test("the starting list control shows how many entries are missing", async ({
  adminPage: page,
}) => {
  await startEditing(page);
  const control = page.getByRole("button", { name: /^Add from starting list/ });
  await expect(control).toHaveText("Add from starting list (0)");
  await expect(control).toBeDisabled();
});

// covers: AC-7, AC-12
test("a moved row is saved, shows after a reload, and is put back", async ({
  adminPage: page,
}) => {
  await startEditing(page);
  const original = await stepNames(page);
  try {
    await keyboardMove(page, "SSIDs", "ArrowDown");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);
    await page.reload();
    const moved = await stepNames(page);
    expect(moved[2]).toBe("SSIDs");
  } finally {
    await startEditing(page);
    const now = await stepNames(page);
    if (now.join("|") !== original.join("|")) {
      await keyboardMove(page, "SSIDs", "ArrowUp");
      await page.getByRole("button", { name: "Save" }).click();
      await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);
    } else {
      await page.getByRole("button", { name: "Discard" }).click();
    }
  }
  await page.reload();
  expect(await stepNames(page)).toEqual(original);
});

// covers: AC-6
test("a row drags by its handle with the mouse and the numbers follow", async ({
  adminPage: page,
}) => {
  await startEditing(page);
  const before = await stepNames(page);
  const handle = page.getByRole("button", { name: /^Reorder SSIDs,/ });
  await handle.scrollIntoViewIfNeeded();
  const from = await handle.boundingBox();
  const to = await page
    .getByRole("button", { name: /^Reorder Guest Service Auth/ })
    .boundingBox();
  if (from === null || to === null) throw new Error("handles not on screen");
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 5, from.y + 40, { steps: 5 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2 + 10, {
    steps: 20,
  });
  await page.mouse.up();
  await expect
    .poll(async () => (await stepNames(page)).indexOf("SSIDs"))
    .toBe(before.indexOf("SSIDs") + 1);
  const after = await stepNames(page);
  expect([...after].sort()).toEqual([...before].sort());
  await expect(page.getByTestId("step-number").first()).toHaveText(/1$/);
  await page.getByRole("button", { name: "Discard" }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Discard" })
    .click();
});

// covers: AC-15
test("edit mode at 390px keeps the handles and does not scroll sideways", async ({
  adminPage: page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await startEditing(page);
  await expect(page.getByRole("button", { name: /^Reorder/ })).toHaveCount(13);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({
    path: "test-results/nile-portal-reset-edit-narrow.png",
    fullPage: true,
  });
});

// covers: AC-23, AC-19
test("the row editor flags bad JSON by path, describes good JSON, and adds only to the draft", async ({
  adminPage: page,
}) => {
  await startEditing(page);
  await page.getByRole("button", { name: "Add row" }).click();
  const dialog = page.getByRole("dialog", { name: "Add a step" });
  await dialog.getByLabel("Name").fill("e2e editor check");
  const json = dialog.getByLabel("Steps, as JSON");
  const apply = dialog.getByRole("button", { name: "Add to draft" });

  // A path on the deny list is flagged next to the text, with its path.
  await json.fill(
    JSON.stringify({
      parts: [{ kind: "call", method: "DELETE", path: "/api/v1/idps/{id}" }],
    }),
  );
  const problems = dialog.getByRole("list", { name: "Problems in the JSON" });
  await expect(problems).toBeVisible();
  await expect(problems.locator("code").first()).toContainText("parts.0");
  await apply.click();
  await expect(dialog).toBeVisible();

  // Valid JSON clears the problems and shows what the step does.
  await json.fill(
    JSON.stringify({
      parts: [
        { kind: "call", method: "DELETE", path: "/api/v1/settings/e2e-check" },
      ],
    }),
  );
  await expect(problems).toBeHidden();
  await expect(dialog.getByText("What this does")).toBeVisible();
  await expect(
    dialog
      .getByRole("listitem")
      .filter({ hasText: "/api/v1/settings/e2e-check" }),
  ).toBeVisible();

  // Applying changes the draft only: Discard leaves the saved list as it was.
  await apply.click();
  await expect(page.getByRole("button", { name: /^Reorder/ })).toHaveCount(14);
  await page.getByRole("button", { name: "Discard" }).click();
  const confirm = page.getByRole("alertdialog");
  if (await confirm.isVisible())
    await confirm.getByRole("button", { name: /Discard/ }).click();
  await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);
  await page.goto("/admin/nile-portal-reset");
  await expect(
    page.getByRole("list", { name: /Reset steps/ }).locator("> li"),
  ).toHaveCount(13);
});
