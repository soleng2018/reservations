import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { formatDateTime } from "../lib/format-time";
import { adminContext } from "./admin-session";
import { haveSecrets, learner, signIn } from "./authentik";
import { expectNoSeriousViolations } from "./axe";
import {
  answerAction,
  continueButton,
  pickStart,
  waitForToken,
} from "./book-flow";

// Feature 13 (spec 0011) in the browser, against the real database and
// Authentik, as hol-test-learner: book again from /reservations, reschedule,
// and cancel. One real booking per run, cancelled at the end. Each screen is
// checked with axe and shot at both widths on the way (AC-18); the card
// states one learner cannot hold at once are in the UI gallery.
test.skip(!haveSecrets, "hol-test passwords are not on this machine");
test.describe.configure({ mode: "serial" });

// A lab type the hol-test fixtures keep bookable.
const TYPE = process.env.E2E_LAB_TYPE ?? "hol-test type";
const LEARNER_ZONE = "UTC"; // hol-test-learner's account zone
const TURNSTILE = '[data-slot="turnstile"]';

const WIDTHS = [
  { name: "1280", width: 1280, height: 800 },
  { name: "390", width: 390, height: 844 },
] as const;

// Axe and a full page shot of the screen at each width, then back to 1280.
async function check(page: Page, name: string) {
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w.width, height: w.height });
    await expectNoSeriousViolations(page, [TURNSTILE]);
    await page.screenshot({
      path: path.join(__dirname, "screenshots", `${w.name}-manage-${name}.png`),
      animations: "disabled",
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1280, height: 800 });
}

// Tabs until `target` has focus.
async function tabTo(page: Page, target: () => Promise<boolean>) {
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press("Tab");
    if (await target()) return;
  }
  throw new Error("never reached the target by Tab");
}
const isFocused = (page: Page, selector: string) => () =>
  page.evaluate(
    (sel) => document.activeElement?.matches(sel) ?? false,
    selector,
  );
const hasFocus = (locator: ReturnType<Page["getByRole"]>) => () =>
  locator.evaluate((el) => el === document.activeElement);

const welcome = (page: Page) =>
  page.getByRole("heading", { name: /^Welcome back/ });
const liveCard = (page: Page) =>
  page.getByRole("listitem").filter({ hasText: /Upcoming|Current/ });

// A booking left by an earlier failed run would block this one.
async function cancelLeftover(page: Page) {
  if ((await liveCard(page).count()) === 0) return;
  await liveCard(page)
    .getByRole("button", { name: "Cancel reservation" })
    .click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Cancel reservation" })
    .click();
  await expect(liveCard(page)).toHaveCount(0);
}

// rescheduleAction posts three arguments; the starts load and the preview
// post one and two.
const isReschedulePost = (body: string) => {
  try {
    const args: unknown = JSON.parse(body);
    return Array.isArray(args) && args.length === 3;
  } catch {
    return false;
  }
};

// covers: AC-1, AC-2, AC-4, AC-5, AC-6, AC-7, AC-8, AC-10, AC-11, AC-12, AC-13, AC-18
test("a learner books again, reschedules, and cancels from /reservations", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1280, height: 800 });

  // AC-1, AC-3: signed in, the list in the account zone.
  await signIn(page, "/reservations", learner);
  await expect(welcome(page)).toBeVisible({ timeout: 30_000 });
  await cancelLeftover(page);
  await expect(page.getByText(`Times in ${LEARNER_ZONE}.`)).toBeVisible();
  await check(page, "1-list");

  // AC-2, AC-13: book again as the account, with only the lab type to pick.
  await page.getByRole("link", { name: "Reserve another lab →" }).click();
  await expect(page.getByText("Booking as")).toBeVisible();
  await expect(page.getByLabel("Email address")).toHaveCount(0);
  await check(page, "2-book-account");
  await page.getByRole("combobox", { name: "Lab type" }).click();
  const option = page.getByRole("option", { name: new RegExp(`^${TYPE} · `) });
  await option.scrollIntoViewIfNeeded();
  await option.click();
  await continueButton(page).click();
  const booked = await pickStart(page);
  await continueButton(page).click();
  await expect(
    page.getByRole("heading", { name: "Confirm your reservation" }),
  ).toBeVisible();
  await expect(page.getByText(learner.username)).toBeVisible();
  await waitForToken(page);
  await page.getByRole("button", { name: "Confirm reservation" }).click();
  await expect(
    page.getByRole("heading", { name: /^You're all set/ }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    page.getByRole("link", { name: "View my reservations" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Done" }).click();

  // AC-1, AC-2: the Upcoming card, and the one active booking rule.
  await expect(welcome(page)).toBeVisible();
  const card = liveCard(page);
  await expect(card).toHaveCount(1);
  await expect(card.getByText("Upcoming")).toBeVisible();
  await expect(
    card.getByText(formatDateTime(new Date(booked), LEARNER_ZONE)),
  ).toBeVisible();
  await expect(
    page.getByText(
      "You have an active reservation. Finish it before booking another.",
    ),
  ).toBeVisible();
  await check(page, "3-list-upcoming");

  // AC-4: the confirm dialog, kept.
  await card.getByRole("button", { name: "Cancel reservation" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog.getByText("Cancel this reservation?")).toBeVisible();
  await expect(dialog.getByText(/^This will free up .+ on /)).toBeVisible();
  await check(page, "4-cancel-dialog");
  await dialog.getByRole("button", { name: "Keep it" }).click();
  await expect(dialog).toBeHidden();

  // AC-6, AC-7, AC-12: Step 2 on its own page, the current start marked.
  await card.getByRole("link", { name: "Reschedule" }).click();
  await expect(page).toHaveURL(
    /\/reservations\/[0-9a-f-]{36}\/reschedule\?step=2$/,
  );
  const bookingId = page.url().split("/")[4] ?? "";
  await expect(
    page.getByRole("heading", { name: "Choose a time" }),
  ).toBeVisible();
  await expect(
    page.getByText("Select a date to see available start times."),
  ).toBeVisible();
  const moved = await pickStart(page);
  expect(moved).not.toBe(booked);
  await expect(page.locator(`input[value="${booked}"]`)).toBeDisabled();
  await expect(page.getByText("Current", { exact: true })).toBeVisible();
  await check(page, "5-reschedule-time");

  // AC-8, AC-12: Step 3 at ?step=3, then browser Back and Forward.
  await continueButton(page).click();
  await expect(
    page.getByRole("heading", { name: "Confirm your new time" }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\?step=3$/);
  await expect(page.getByText("Current time")).toBeVisible();
  await expect(page.getByText("Finding a free testbed")).toBeHidden();
  await check(page, "6-reschedule-confirm");
  await page.goBack();
  await expect(
    page.getByRole("heading", { name: "Choose a time" }),
  ).toBeVisible();
  await page.goForward();
  await expect(
    page.getByRole("heading", { name: "Confirm your new time" }),
  ).toBeVisible();

  // AC-10, AC-11: progress, a lost reply, then success, all answered by the
  // test so nothing moves yet.
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await answerAction(page, "**/reschedule**", isReschedulePost, [
    { kind: "hold", release: held },
    {
      kind: "reply",
      body: {
        kind: "rescheduled",
        testbedName: "Lab bench 03",
        typeName: TYPE,
        startsAt: moved,
        endsAt: moved,
        access: null,
      },
    },
  ]);
  await page.getByRole("button", { name: "Confirm new time" }).click();
  await expect(
    page.getByRole("heading", { name: "Updating your reservation" }),
  ).toBeVisible();
  await check(page, "7-progress");
  release();
  await expect(
    page.getByText(/^We couldn't confirm the change\./),
  ).toBeVisible();
  await check(page, "8-failure");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(
    page.getByRole("heading", {
      name: "Your reservation has been rescheduled.",
    }),
  ).toBeVisible();
  await check(page, "9-success");
  await page.unrouteAll({ behavior: "wait" });

  // AC-9, AC-18: the real move, with the keyboard alone.
  await page.goto("/reservations");
  await expect(welcome(page)).toBeVisible();
  await tabTo(
    page,
    hasFocus(liveCard(page).getByRole("link", { name: "Reschedule" })),
  );
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Choose a time" }),
  ).toBeVisible();
  const freeDay = '[data-slot="calendar"] button[data-day]:not([disabled])';
  await expect(page.locator(freeDay).first()).toBeVisible({ timeout: 20_000 });
  await tabTo(page, isFocused(page, freeDay));
  await page.keyboard.press("Enter");
  await expect(page.locator("h2[tabindex='-1']")).toBeFocused();
  await page.keyboard.press("Tab"); // the first free start (Current is disabled)
  await page.keyboard.press("Space");
  const checked = page.locator('input[name="startsAt"]:checked');
  await expect(checked).toHaveCount(1);
  const newStart = await checked.inputValue();
  expect(newStart).not.toBe(booked);
  await tabTo(page, hasFocus(page.getByRole("button", { name: "Continue" })));
  await page.keyboard.press("Enter");
  await expect(page.getByText("Finding a free testbed")).toBeHidden({
    timeout: 20_000,
  });
  await tabTo(
    page,
    hasFocus(page.getByRole("button", { name: "Confirm new time" })),
  );
  await page.keyboard.press("Enter");
  const success = page.getByRole("heading", {
    name: "Your reservation has been rescheduled.",
  });
  await expect(success).toBeVisible({ timeout: 30_000 });
  await expect(success).toBeFocused();
  await tabTo(page, hasFocus(page.getByRole("link", { name: "Done" })));
  await page.keyboard.press("Enter");
  await expect(welcome(page)).toBeVisible();
  await expect(
    liveCard(page).getByText(formatDateTime(new Date(newStart), LEARNER_ZONE)),
  ).toBeVisible();

  // AC-4, AC-18: cancel with the keyboard alone; the testbed is freed.
  await tabTo(
    page,
    hasFocus(
      liveCard(page).getByRole("button", { name: "Cancel reservation" }),
    ),
  );
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Keep it" })).toBeFocused();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Reservation cancelled.")).toBeVisible();
  await expect(liveCard(page)).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Reserve another lab →" }),
  ).toBeVisible();

  // AC-6: the cancelled booking can't be moved; a malformed id is not found.
  await page.goto(`/reservations/${bookingId}/reschedule`);
  await expect(
    page.getByRole("heading", {
      name: "This reservation can't be rescheduled any more.",
    }),
  ).toBeVisible();
  await check(page, "10-cannot-reschedule");
  const missing = await page.goto("/reservations/not-a-booking/reschedule");
  expect(missing?.status()).toBe(404);
});

// covers: AC-3 (spec 0003 AC-9 end to end)
test("a deactivated learner cannot sign in", async ({ browser, page }) => {
  test.setTimeout(180_000);
  const admin = await adminContext(browser);
  const console_ = await admin.newPage();
  const status = async (button: string, done: RegExp) => {
    await console_.goto("/admin/users");
    await console_
      .getByRole("searchbox", { name: "Search users" })
      .fill(learner.username);
    await console_
      .getByRole("row")
      .filter({ hasText: learner.username })
      .getByRole("link", { name: /^View / })
      .click();
    await console_.getByRole("button", { name: button }).click();
    if (button === "Deactivate user")
      await console_
        .getByRole("alertdialog")
        .getByRole("button", { name: "Deactivate", exact: true })
        .click();
    await expect(console_.getByText(done)).toBeVisible({ timeout: 30_000 });
  };

  await status("Deactivate user", /^Deactivated HOL Test Learner/);
  try {
    await page.goto("/reservations");
    await page.getByRole("button", { name: /sign in/i }).click();
    await page
      .getByRole("textbox", { name: /email or username/i })
      .fill(learner.username);
    await page.getByRole("button", { name: /log in|continue/i }).click();
    const password = page.getByLabel(/password/i).first();
    const refusedByApp = page.getByRole("heading", {
      name: "Account deactivated",
    });
    await expect(password.or(refusedByApp)).toBeVisible({ timeout: 20_000 });
    if (await password.isVisible()) {
      await password.fill(learner.password ?? "");
      await page.getByRole("button", { name: /continue|log in/i }).click();
    }
    // Authentik refuses the inactive account, or the app does: either way
    // no signed in page ever shows.
    await page.waitForLoadState("networkidle");
    await expect(welcome(page)).toHaveCount(0);
    expect(
      page.url().startsWith("https://authentik.") ||
        page.url().includes("/auth/error?reason=deactivated"),
    ).toBe(true);
  } finally {
    await status("Reactivate user", /^Reactivated HOL Test Learner\./);
    await admin.close();
  }
});
