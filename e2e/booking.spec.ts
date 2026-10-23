import { expect, test, type Page } from "@playwright/test";
import { z } from "zod";
import {
  ADMIN_ENTRY,
  admin,
  authentikGet,
  haveApi,
  haveProvisioning,
  haveSecrets,
  makeTestbedGroup,
  results,
  signIn,
} from "./authentik";
import {
  answerBook,
  continueButton,
  failed,
  fillDetails,
  guest,
  pickStart,
  toConfirm,
  waitForToken,
} from "./book-flow";

// The booking loop end to end (spec 0004, spec 0010), against the real
// database and real Authentik. It commits what it creates (a type, a testbed,
// learners, bookings), all named `e2e ` / `dev-` so they can be found and
// cleaned up by hand. The testbed is named like an Authentik group, so the
// test makes a throwaway marked group `dev-e2e-bench-…` first (the app creates
// no group, spec 0017) and leaves it: the testbed keeps a booking. In dev all
// callers share the per IP buckets, so this file makes 3 real bookings and 6
// Step 1 checks (limits 5 and 20 per 10 minutes).
test.skip(
  !haveSecrets || !haveProvisioning,
  "hol-test passwords or the provisioning token are not on this machine",
);

const id = crypto.randomUUID().slice(0, 8);
const typeName = `e2e type ${id}`;
const testbedName = `dev-e2e-bench-${id}`;
const first = guest(`guest-${id}`);

async function choose(page: Page, combobox: string, option: string) {
  await page.getByRole("combobox", { name: combobox }).click();
  const item = page.getByRole("option", { name: option, exact: true });
  await item.scrollIntoViewIfNeeded();
  await item.click();
}

const half = (iso: string, n: number) =>
  new Date(new Date(iso).getTime() + n * 30 * 60_000).toISOString();

const slotOf = (page: Page, iso: string) =>
  page.locator(`label:has(input[value="${iso}"]) span`);

test.describe.serial("booking", () => {
  // covers: spec 0004 AC-1, AC-2
  test("an admin creates a type and a testbed", async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page, ADMIN_ENTRY, admin);
    await expect(page).toHaveURL(/\/admin\/testbed-types$/);
    await page.getByRole("button", { name: "Add type" }).click();
    const typeDialog = page.getByRole("dialog", { name: "Add testbed type" });
    await typeDialog.getByLabel("Name").fill(typeName);
    await typeDialog.getByLabel("Duration").fill("1");
    await typeDialog.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText(`Created ${typeName}.`)).toBeVisible();
    await expect(typeDialog).toBeHidden();
    await page.getByLabel("Search testbed types").fill(typeName);
    await expect(
      page.getByRole("cell", { name: typeName, exact: true }),
    ).toBeVisible();

    await page.getByRole("link", { name: "Testbeds", exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/testbeds$/);
    await makeTestbedGroup(testbedName, true);
    await page.getByRole("button", { name: "Add testbed" }).click();
    const testbedDialog = page.getByRole("dialog", { name: "Add testbed" });
    await testbedDialog.getByLabel("Name", { exact: true }).fill(testbedName);
    await testbedDialog
      .getByLabel("Domain", { exact: true })
      .fill(`dev-e2e-${id}.nile-test.invalid`);
    await choose(page, "Testbed type", typeName);
    await testbedDialog
      .getByLabel("Nile Portal URL")
      .fill("https://portal.nile-test.invalid");
    await testbedDialog
      .getByLabel("LMS URL")
      .fill("https://lms.nile-test.invalid");
    await testbedDialog.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText(`Created ${testbedName}.`)).toBeVisible({
      timeout: 30_000,
    });
    await page.getByLabel("Search testbeds").fill(testbedName);
    // A live testbed always has its group pk (spec 0017 AC-11).
    const testbedRow = page.getByRole("row").filter({ hasText: testbedName });
    await expect(testbedRow).toBeVisible();
    await expect(testbedRow).not.toContainText("Not ready");

    if (haveApi) {
      const groups = await authentikGet(
        results(
          z.looseObject({ name: z.string(), attributes: z.looseObject({}) }),
        ),
        `/core/groups/?name=${testbedName}`,
      );
      // The test's own group, untouched by the app (spec 0017 AC-4).
      expect(groups.results).toHaveLength(1);
      expect(groups.results[0]?.attributes.hol_testbed_group).toBe(true);
      expect(groups.results[0]?.attributes).not.toHaveProperty(
        "hol_testbed_id",
      );
    }
  });

  // covers: spec 0010 AC-1, AC-4, AC-5, AC-7, AC-8, AC-10
  test("a guest books it through the three steps", async ({ browser }) => {
    test.setTimeout(120_000);
    const page = await browser.newPage({ timezoneId: "America/New_York" });
    await page.goto("/book");

    // Step 1 (AC-1): the type labelled with its duration, the zone preset.
    await expect(page.getByText("Step 1 of 3")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Tell us about you" }),
    ).toBeVisible();
    await expect(page.getByLabel("Your timezone")).toHaveValue(
      /^America\/New York \(GMT-[45]\)$/,
    );
    await fillDetails(page, first, typeName);
    await expect(
      page.getByRole("combobox", { name: "Lab type" }),
    ).toContainText(`${typeName} · 1 hour`);
    await continueButton(page).click();

    // Step 2 (AC-4, AC-5): days before today are greyed, a day shows its
    // starts, and a start highlights its whole hour.
    await expect(page).toHaveURL(/\/book\?step=2$/);
    await expect(page.getByText(`${typeName} · 1 hour`)).toBeVisible();
    await expect(
      page.getByText("Select a date to see available start times."),
    ).toBeVisible();
    const pastEnabled = await page
      .locator('[data-slot="calendar"] button[data-day]')
      .evaluateAll((days) => {
        const today = days.findIndex((d) => d.dataset.today === "true");
        return days
          .slice(0, Math.max(today, 0))
          .filter((d) => !(d as HTMLButtonElement).disabled).length;
      });
    expect(pastEnabled).toBe(0);
    const start = await pickStart(page);
    await expect(slotOf(page, start)).toHaveClass(/bg-primary/);
    await expect(slotOf(page, half(start, 1))).toHaveClass(/bg-primary/);
    await expect(slotOf(page, half(start, 2))).not.toHaveClass(/bg-primary/);
    await expect(
      page.getByText(/^1 hour reservation: .+ to .+E[SD]T$/),
    ).toBeVisible();
    await continueButton(page).click();

    // Step 3 (AC-7): the preview names the one testbed.
    await expect(page).toHaveURL(/\/book\?step=3$/);
    await expect(page.getByText(testbedName)).toBeVisible();
    await expect(
      page.getByText(/America\/New York \(GMT-[45]\)/),
    ).toBeVisible();
    await waitForToken(page);
    await page.getByRole("button", { name: "Confirm reservation" }).click();

    // Progress (AC-8), then success (AC-10).
    await expect(
      page.getByRole("heading", { name: "Setting up your reservation" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: /^You're all set, E2E!$/ }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page).toHaveURL(/\/book$/);
    await expect(page.getByText(testbedName)).toBeVisible();
    await expect(page.getByText(typeName)).toBeVisible();
    await expect(page.getByText(first.email)).toBeVisible();
    await expect(
      page.getByText("Check your inbox for a link to set your password."),
    ).toBeVisible();

    if (haveApi) {
      const users = await authentikGet(
        results(z.looseObject({ attributes: z.looseObject({}) })),
        `/core/users/?username=${encodeURIComponent(first.email)}`,
      );
      expect(users.results).toHaveLength(1);
      expect(users.results[0]?.attributes.hol_learner).toBe(true);
    }
    await page.close();
  });

  // covers: spec 0010 AC-3
  test("the same email is stopped at Step 1", async ({ page }) => {
    await page.goto("/book");
    await fillDetails(
      page,
      { ...first, email: first.email.toUpperCase() },
      typeName,
    );
    await continueButton(page).click();
    const panel = page.getByRole("alert").filter({
      hasText: "You already have an active reservation",
    });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("Sign in to manage it.");
    await expect(
      panel.getByRole("link", { name: "Manage my reservations" }),
    ).toHaveAttribute("href", "/reservations");
    await expect(panel).not.toContainText(first.name);
    await expect(panel).not.toContainText(/\d:\d\d/);
    await expect(page).toHaveURL(/\/book$/);

    // Editing the email clears the panel.
    await page.getByLabel("Email address").fill("someone@nile-test.invalid");
    await expect(panel).toBeHidden();
  });

  // covers: spec 0010 AC-11
  test("Back and Forward move between steps; a refresh starts over", async ({
    page,
  }) => {
    const start = await toConfirm(page, guest(`history-${id}`), typeName);

    await page.goBack();
    await expect(page).toHaveURL(/\/book\?step=2$/);
    await expect(page.locator(`input[value="${start}"]`)).toBeChecked();
    await page.goBack();
    await expect(page).toHaveURL(/\/book$/);
    await expect(page.getByLabel("Full name")).toHaveValue(/^E2E history/);
    await page.goForward();
    await expect(
      page.getByRole("heading", { name: "Choose a time" }),
    ).toBeVisible();
    await page.goForward();
    await expect(
      page.getByRole("heading", { name: "Confirm your reservation" }),
    ).toBeVisible();

    await page.reload();
    await expect(page).toHaveURL(/\/book$/);
    await expect(
      page.getByRole("heading", { name: "Tell us about you" }),
    ).toBeVisible();
    await expect(page.getByLabel("Full name")).toHaveValue("");

    await page.goto("/book?step=2");
    await expect(page).toHaveURL(/\/book$/);
    await expect(page.getByLabel("Email address")).toHaveValue("");
  });

  // covers: spec 0010 AC-6, AC-9, AC-12 (spec 0004 AC-10 through the flow)
  test("two guests confirm the last free start at once", async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const pages = await Promise.all(
      [0, 1].map(async () =>
        (await browser.newContext({ timezoneId: "UTC" })).newPage(),
      ),
    );
    const [a, b] = pages as [Page, Page];
    const starts = [
      await toConfirm(a, guest(`race-a-${id}`), typeName),
      await toConfirm(b, guest(`race-b-${id}`), typeName),
    ];
    expect(starts[0]).toBe(starts[1]);

    await Promise.all(
      pages.map((p) =>
        p.getByRole("button", { name: "Confirm reservation" }).click(),
      ),
    );
    const won = (p: Page) =>
      p
        .getByRole("heading", { name: /^You're all set/ })
        .waitFor({ timeout: 30_000 })
        .then(() => true);
    const lost = (p: Page) =>
      p
        .getByText("That time is no longer available. Please pick another.")
        .waitFor({ timeout: 30_000 })
        .then(() => false);
    const outcomes = await Promise.all(
      pages.map((p) => Promise.race([won(p), lost(p)])),
    );
    expect(outcomes.filter(Boolean)).toHaveLength(1);

    const winner = outcomes[0] ? a : b;
    const loser = outcomes[0] ? b : a;
    await expect(winner.getByText(testbedName)).toBeVisible();
    await expect(loser).toHaveURL(/\/book\?step=2$/);
    await expect(
      loser.getByRole("heading", { name: "Choose a time" }),
    ).toBeVisible();
    // The reload drops the taken time: it is greyed, or its day is gone.
    await expect(
      loser.locator(`input[value="${starts[0]}"]:not([disabled])`),
    ).toHaveCount(0);
    await expect(continueButton(loser)).toBeDisabled();
    await Promise.all(pages.map((p) => p.context().close()));
  });

  // covers: spec 0010 AC-9 (bookAction answered by the test: nothing is
  // booked)
  test("the failure screens, and Try again on a fresh token", async ({
    page,
  }) => {
    const count = await answerBook(page, [
      { kind: "reply", body: failed("unavailable") },
      { kind: "abort" },
    ]);
    await toConfirm(page, guest(`failure-${id}`), typeName);
    await page.getByRole("button", { name: "Confirm reservation" }).click();

    await expect(
      page.getByRole("heading", { name: "Something went wrong" }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "We couldn't complete your reservation. Nothing was booked. Please try again.",
      ),
    ).toBeVisible();
    expect(count()).toBe(1);

    // The widget resets after the reply; Try again waits for its token.
    const tryAgain = page.getByRole("button", { name: "Try again" });
    await expect(tryAgain).toBeEnabled({ timeout: 20_000 });
    await tryAgain.click();
    await expect(
      page.getByText(/If it went through, you.ll find it under/),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Manage an existing reservation" }),
    ).toHaveAttribute("href", "/reservations");
    expect(count()).toBe(2);

    // Back returns to Step 3 with the details kept.
    await page.getByRole("button", { name: "Back" }).click();
    await expect(
      page.getByRole("heading", { name: "Confirm your reservation" }),
    ).toBeVisible();
    await expect(page.getByText(`E2E failure-${id} Guest`)).toBeVisible();
  });
});
