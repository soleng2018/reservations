import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
import { adminContext, test } from "./admin-session";
import { ADMIN_ENTRY, haveSecrets } from "./authentik";
import {
  answerBook,
  booked,
  guest,
  waitForToken,
  walkScreens,
} from "./book-flow";

// Spec 0005 AC-14: no serious or critical axe violation on the shell, the
// sign in card, /book, and the gallery's dialogs.
test.skip(!haveSecrets, "hol-test passwords are not on this machine");

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function expectNoSeriousViolations(
  page: Page,
  exclude: readonly string[] = [],
) {
  const results = await exclude
    .reduce((axe, sel) => axe.exclude(sel), new AxeBuilder({ page }))
    .withTags(TAGS)
    .analyze();
  const serious = results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map(
      (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
    );
  expect(serious).toEqual([]);
}

// covers: AC-14
test("the shell at 1280px", async ({ adminPage: page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/admin/testbed-types");
  await expect(
    page.getByRole("heading", { name: "Testbed Types" }),
  ).toBeVisible();
  await expectNoSeriousViolations(page);
});

// covers: AC-4, AC-14
test("the shell at 390px with the drawer open", async ({ browser }) => {
  const context = await adminContext(browser, {
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  await page.goto("/admin/testbed-types");
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(page.locator("[data-slot=sheet-content]")).toBeVisible();
  await expectNoSeriousViolations(page);
  await context.close();
});

// covers: AC-10, AC-14
test("the admin sign in card", async ({ page }) => {
  await page.goto(ADMIN_ENTRY);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expectNoSeriousViolations(page);
});

// Spec 0010 AC-14: every /book screen at both widths (Turnstile is third
// party content), and a booking made with the keyboard alone.
for (const viewport of [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
]) {
  // covers: AC-11, AC-14, spec 0010 AC-14
  test(`each /book screen at ${viewport.width}px`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize(viewport);
    await walkScreens(page, () =>
      expectNoSeriousViolations(page, ['[data-slot="turnstile"]']),
    );
  });
}

// covers: spec 0010 AC-14 (bookAction answered by the test)
test("a keyboard alone completes a booking", async ({ page }) => {
  test.setTimeout(120_000);
  const start = { iso: "" };
  await answerBook(page, [
    {
      kind: "reply",
      body: () => booked(start.iso, start.iso),
    },
  ]);
  const who = guest("keyboard");
  const focused = () =>
    page.evaluate(() => {
      const el = document.activeElement;
      return el
        ? `${el.tagName} ${el.getAttribute("aria-label") ?? ""} ${el.textContent?.trim().slice(0, 40) ?? ""}`
        : "";
    });
  // Tabs until `done` holds for the focused element.
  const tabTo = async (done: () => Promise<boolean>) => {
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press("Tab");
      if (await done()) return;
    }
    throw new Error(`never reached the target; at ${await focused()}`);
  };

  await page.goto("/book");
  await expect(page.getByLabel("Your timezone")).not.toHaveValue("");
  await tabTo(async () =>
    page
      .getByLabel("Full name")
      .evaluate((el) => el === document.activeElement),
  );
  await page.keyboard.type(who.name);
  await page.keyboard.press("Tab");
  await page.keyboard.type(who.company);
  await page.keyboard.press("Tab");
  await page.keyboard.type(who.email);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter"); // opens the Lab type list
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("combobox", { name: "Lab type" }),
  ).not.toContainText("Select a lab type");
  await tabTo(() =>
    page
      .getByRole("button", { name: "Continue" })
      .evaluate((el) => el === document.activeElement),
  );
  await page.keyboard.press("Enter"); // submits Step 1

  await expect(
    page.getByRole("heading", { name: "Choose a time" }),
  ).toBeVisible();
  await expect(
    page
      .locator('[data-slot="calendar"] button[data-day]:not([disabled])')
      .first(),
  ).toBeVisible({ timeout: 20_000 });
  await tabTo(() =>
    page.evaluate(
      () =>
        document.activeElement?.matches(
          '[data-slot="calendar"] button[data-day]:not([disabled])',
        ) ?? false,
    ),
  );
  await page.keyboard.press("Enter"); // picks the focused day
  await expect(page.locator("h2[tabindex='-1']")).toBeFocused();
  await page.keyboard.press("Tab"); // the first free start
  await page.keyboard.press("Space");
  const checked = page.locator('input[name="startsAt"]:checked');
  await expect(checked).toHaveCount(1);
  start.iso = await checked.inputValue();
  await tabTo(() =>
    page
      .getByRole("button", { name: "Continue" })
      .evaluate((el) => el === document.activeElement),
  );
  await page.keyboard.press("Enter");

  await expect(
    page.getByRole("heading", { name: "Confirm your reservation" }),
  ).toBeVisible();
  await waitForToken(page);
  await tabTo(() =>
    page
      .getByRole("button", { name: "Confirm reservation" })
      .evaluate((el) => el === document.activeElement),
  );
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: /^You're all set/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: /^You're all set/ }),
  ).toBeFocused();
});

// covers: AC-7, AC-8, AC-14
test("the gallery with each dialog open", async ({ adminPage: page }) => {
  await page.goto("/admin/ui-gallery");
  await expectNoSeriousViolations(page);

  await page.getByRole("button", { name: "Open form modal" }).click();
  await expect(
    page.getByRole("dialog", { name: "Add sample type" }),
  ).toBeVisible();
  await expectNoSeriousViolations(page);
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Delete Advanced" }).click();
  await expect(
    page.getByRole("alertdialog", { name: "Delete this?" }),
  ).toBeVisible();
  await expectNoSeriousViolations(page);
  await page.getByRole("button", { name: "Cancel" }).click();

  await page.getByRole("button", { name: "Delete Basic" }).click();
  await expect(
    page.getByRole("dialog", { name: "Testbed type in use" }),
  ).toBeVisible();
  await expectNoSeriousViolations(page);
});

// Spec 0009 AC-10: the landing at both widths, its skip link, and its
// heading order.
for (const viewport of [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
]) {
  // covers: AC-10 (spec 0009)
  test(`the landing at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expectNoSeriousViolations(page);
  });
}

// covers: AC-10 (spec 0009)
test("the landing's skip link and heading order", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to content" });
  await expect(skip).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("main#content")).toBeFocused();

  const levels = await page
    .locator("h1, h2, h3, h4, h5, h6")
    .evaluateAll((hs) => hs.map((h) => Number(h.tagName.slice(1))));
  expect(levels).toEqual([1, 2, 3, 3, 3]);
});
