import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { haveSecrets, learner, signIn } from "./authentik";
import { expectNoSeriousViolations } from "./axe";
import { continueButton, pickStart, waitForToken } from "./book-flow";
import { resetDevBookingLimits } from "./db";

// Feature 14 (spec 0012) in the browser, against the real database and
// Authentik, as hol-test-learner: book through signed in /book and see the
// lab access card, open the Upcoming detail page by URL, then cancel. One
// real booking per run; afterEach cancels any the account still holds, so a
// failed run never leaves it blocked by the one active booking rule. Current
// and Past cards need the clock to move, so verify.md covers those by hand.
test.skip(!haveSecrets, "hol-test passwords are not on this machine");
test.beforeAll(resetDevBookingLimits);
test.describe.configure({ mode: "serial" });

const TYPE = process.env.E2E_LAB_TYPE ?? "hol-test type";
const TURNSTILE = '[data-slot="turnstile"]';

const WIDTHS = [
  { name: "1280", width: 1280, height: 800 },
  { name: "390", width: 390, height: 844 },
] as const;

async function check(page: Page, name: string) {
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w.width, height: w.height });
    await expectNoSeriousViolations(page, [TURNSTILE]);
    await page.screenshot({
      path: path.join(__dirname, "screenshots", `${w.name}-lab-${name}.png`),
      animations: "disabled",
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1280, height: 800 });
}

async function tabTo(page: Page, target: Locator) {
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press("Tab");
    if (await target.evaluate((el) => el === document.activeElement)) return;
  }
  throw new Error("never reached the target by Tab");
}

const welcome = (page: Page) =>
  page.getByRole("heading", { name: /^Welcome back/ });
const liveCard = (page: Page) =>
  page.getByRole("listitem").filter({ hasText: /Upcoming|Current/ });

// Cancels every live booking on the list the page is showing.
async function cancelLive(page: Page) {
  while ((await liveCard(page).count()) > 0) {
    await liveCard(page)
      .first()
      .getByRole("button", { name: "Cancel reservation" })
      .click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Cancel reservation" })
      .click();
    await expect(page.getByText("Reservation cancelled.")).toBeVisible();
    await expect(page.getByText("Reservation cancelled.")).toBeHidden();
  }
}

// Each "Open" link leaves for the lab in a new tab, without an opener or a
// referrer (AC-2).
async function expectLinks(card: Locator) {
  const links = card.getByRole("link", { name: /^Open / });
  expect(await links.count()).toBeGreaterThanOrEqual(2);
  for (const link of await links.all()) {
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
    await expect(link).toHaveAttribute("href", /^https:\/\//);
  }
  await expect(
    card.getByRole("link", { name: /^Open Nile Portal/ }),
  ).toBeVisible();
  await expect(
    card.getByRole("link", { name: /^Open LMS course/ }),
  ).toBeVisible();
}

test.afterEach(async ({ page }) => {
  await page.goto("/reservations");
  const signedIn = await welcome(page)
    .waitFor({ timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (signedIn) await cancelLive(page);
});

// covers: AC-2, AC-6, AC-7
test("a signed in learner sees their lab access after booking and on the detail page", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await signIn(page, "/reservations", learner);
  await expect(welcome(page)).toBeVisible({ timeout: 30_000 });
  await cancelLive(page);

  // AC-2: book as the account; the card sits under "View my reservations".
  await page.getByRole("link", { name: "Reserve another lab →" }).click();
  await expect(page.getByText("Booking as")).toBeVisible();
  await page.getByRole("combobox", { name: "Lab type" }).click();
  const option = page.getByRole("option", { name: new RegExp(`^${TYPE} · `) });
  await option.scrollIntoViewIfNeeded();
  await option.click();
  await continueButton(page).click();
  await pickStart(page);
  await continueButton(page).click();
  await waitForToken(page);
  await page.getByRole("button", { name: "Confirm reservation" }).click();
  await expect(
    page.getByRole("heading", { name: /^You're all set/ }),
  ).toBeVisible({ timeout: 30_000 });
  const mine = page.getByRole("link", { name: "View my reservations" });
  const success = page.getByRole("region", { name: "Your lab access" });
  await expect(mine).toBeVisible();
  await expect(success).toBeVisible();
  await expect(
    success.getByText(
      "These links start working at your start time (allow up to a minute).",
    ),
  ).toBeVisible();
  const [mineBox, cardBox] = await Promise.all([
    mine.boundingBox(),
    success.boundingBox(),
  ]);
  expect(mineBox?.y ?? 0).toBeLessThan(cardBox?.y ?? 0);
  await expectLinks(success);
  await tabTo(page, success.getByRole("link", { name: /^Open Nile Portal/ }));
  await check(page, "1-success");
  await page.getByRole("link", { name: "Done" }).click();

  // AC-6: the Upcoming card gets no View lab access.
  await expect(welcome(page)).toBeVisible();
  const card = liveCard(page);
  await expect(card).toHaveCount(1);
  await expect(card.getByText("Upcoming")).toBeVisible();
  await expect(card.getByRole("link", { name: "View lab access" })).toHaveCount(
    0,
  );
  const href =
    (await card
      .getByRole("link", { name: "Reschedule" })
      .getAttribute("href")) ?? "";
  const bookingId = href.split("/")[2] ?? "";
  expect(bookingId).toMatch(/^[0-9a-f-]{36}$/);

  // AC-7: the Upcoming detail page, reachable by URL only.
  await page.goto(`/reservations/${bookingId}`);
  await expect(page).toHaveTitle(/Lab access/);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByText("Upcoming", { exact: true })).toBeVisible();
  const detail = page.getByRole("region", { name: "Lab access" });
  await expect(
    detail.getByText(
      "These links start working at your start time (allow up to a minute). Quote the testbed name below if you contact support.",
    ),
  ).toBeVisible();
  await expect(detail.getByText("Testbed assigned")).toBeVisible();
  await expectLinks(detail);
  await check(page, "2-detail-upcoming");

  // The way back, by keyboard.
  const back = page.getByRole("link", { name: "All reservations" });
  await tabTo(page, back);
  await page.keyboard.press("Enter");
  await expect(welcome(page)).toBeVisible();

  // AC-7: once cancelled, the detail page is not found.
  await cancelLive(page);
  await expect(liveCard(page)).toHaveCount(0);
  const gone = await page.goto(`/reservations/${bookingId}`);
  expect(gone?.status()).toBe(404);
});
