import { expect, type Page } from "@playwright/test";

// Steps through the /book flow (spec 0010) and, where a test must not make a
// real booking, answers bookAction itself. The real reply's header line
// (`0:{…"b":"<build>"}`) is copied from an earlier action of the same page,
// so the client accepts the crafted one.

export type Guest = {
  readonly name: string;
  readonly company: string;
  readonly email: string;
};

export const guest = (tag: string): Guest => ({
  name: `E2E ${tag} Guest`,
  company: "Nile test",
  email: `dev-${tag}-${crypto.randomUUID().slice(0, 8)}@nile-test.invalid`,
});

// Step 1: the fields and a lab type (the named one, else the first).
export async function fillDetails(page: Page, who: Guest, typeName?: string) {
  await page.getByLabel("Full name").fill(who.name);
  await page.getByLabel("Company name").fill(who.company);
  await page.getByLabel("Email address").fill(who.email);
  await page.getByRole("combobox", { name: "Lab type" }).click();
  const option = typeName
    ? page.getByRole("option", { name: new RegExp(`^${typeName} · `) })
    : page.getByRole("option").first();
  await option.scrollIntoViewIfNeeded();
  await option.click();
}

export const continueButton = (page: Page) =>
  page.getByRole("button", { name: "Continue" });

// Step 2: the first day with a free start, then its `nth` free start.
// Returns the start's ISO instant.
export async function pickStart(page: Page, nth = 0): Promise<string> {
  await expect(
    page.getByRole("heading", { name: "Choose a time" }),
  ).toBeVisible();
  const day = page
    .locator('[data-slot="calendar"] button[data-day]:not([disabled])')
    .first();
  await expect(day).toBeVisible({ timeout: 20_000 });
  await day.click();
  const radio = page.locator('input[name="startsAt"]:not([disabled])').nth(nth);
  const iso = await radio.inputValue();
  await page.locator(`label:has(input[value="${iso}"])`).click();
  await expect(radio).toBeChecked();
  return iso;
}

// Step 3: Cloudflare's test keys pass at once; wait for the token to land.
export async function waitForToken(page: Page) {
  await expect(
    page.getByRole("button", { name: "Confirm reservation" }),
  ).toBeEnabled({ timeout: 20_000 });
}

// Through Steps 1 to 3, ready to confirm.
export async function toConfirm(
  page: Page,
  who: Guest,
  typeName?: string,
): Promise<string> {
  await page.goto("/book");
  await fillDetails(page, who, typeName);
  await continueButton(page).click();
  const iso = await pickStart(page);
  await continueButton(page).click();
  await expect(
    page.getByRole("heading", { name: "Confirm your reservation" }),
  ).toBeVisible();
  await waitForToken(page);
  return iso;
}

export type BookReply =
  // `body` may be a function, read when the request arrives.
  | { readonly kind: "reply"; readonly body: object | (() => object) }
  | { readonly kind: "abort" } // a lost reply
  | { readonly kind: "hold"; readonly release: Promise<void> }; // progress

// Answers every bookAction request with the next reply in turn (the last
// one repeats). Returns how many it answered. Other requests pass through.
export async function answerBook(
  page: Page,
  replies: readonly BookReply[],
): Promise<() => number> {
  let header: string | null = null;
  page.on("response", async (r) => {
    if (!r.request().headers()["next-action"]) return;
    const first = (await r.text().catch(() => "")).split("\n")[0];
    if (first?.startsWith("0:")) header = first;
  });
  let answered = 0;
  await page.route("**/book**", async (route) => {
    const req = route.request();
    if (
      req.method() !== "POST" ||
      !req.headers()["next-action"] ||
      !(req.postData() ?? "").includes("cf-turnstile-response")
    )
      return route.fallback();
    const reply = replies[Math.min(answered, replies.length - 1)];
    answered += 1;
    if (!reply || reply.kind === "abort") return route.abort("failed");
    if (reply.kind === "hold") {
      await reply.release;
      return route.abort("failed");
    }
    if (!header) throw new Error("no earlier action reply to copy");
    await route.fulfill({
      status: 200,
      contentType: "text/x-component",
      body: `${header}\n1:${JSON.stringify(typeof reply.body === "function" ? reply.body() : reply.body)}\n`,
    });
  });
  return () => answered;
}

export const booked = (startsAt: string, endsAt: string) => ({
  kind: "booked",
  typeName: "White Belt Series",
  testbedName: "Lab bench 03",
  startsAt,
  endsAt,
  timezone: "America/New_York",
  newUser: true,
});

export const failed = (code: string) => ({ kind: "error", code, fields: {} });

export type BookScreen =
  | "1-details"
  | "2-time"
  | "3-confirm"
  | "4-progress"
  | "5-failure"
  | "6-success";

// Every /book screen in turn, calling `at` on each (spec 0010 AC-14). One
// Step 1 check; bookAction is answered by the test (held for progress, then
// lost, then booked), so nothing is booked.
export async function walkScreens(
  page: Page,
  at: (screen: BookScreen) => Promise<void>,
) {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const start = { iso: "" };
  await answerBook(page, [
    { kind: "hold", release: held },
    {
      kind: "reply",
      body: () =>
        booked(
          start.iso,
          new Date(new Date(start.iso).getTime() + 4 * 3_600_000).toISOString(),
        ),
    },
  ]);
  await page.goto("/book");
  await expect(
    page.getByRole("heading", { name: "Tell us about you" }),
  ).toBeVisible();
  await expect(page.getByLabel("Your timezone")).not.toHaveValue("");
  await at("1-details");

  await fillDetails(page, guest("screens"));
  await continueButton(page).click();
  start.iso = await pickStart(page, 4);
  await at("2-time");

  await continueButton(page).click();
  await expect(page.getByText("Testbed assigned")).toBeVisible();
  await expect(page.getByText("Finding a free testbed")).toBeHidden();
  await waitForToken(page);
  await at("3-confirm");

  await page.getByRole("button", { name: "Confirm reservation" }).click();
  await expect(
    page.getByRole("heading", { name: "Setting up your reservation" }),
  ).toBeVisible();
  await expect(page.getByText("Setting up your account, done")).toBeAttached();
  await at("4-progress");

  release();
  await expect(
    page.getByRole("heading", { name: "Something went wrong" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeEnabled({
    timeout: 20_000,
  });
  await at("5-failure");

  await page.getByRole("button", { name: "Try again" }).click();
  await expect(
    page.getByRole("heading", { name: /^You're all set/ }),
  ).toBeVisible();
  await at("6-success");
}
