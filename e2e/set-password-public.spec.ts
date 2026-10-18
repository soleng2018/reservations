import { expect, test } from "@playwright/test";

// Spec 0014 checks that need no fixture account, only the running dev
// server: the public link page's head, and a sign in callback that lost its
// state (AC-19).

// A well formed token no link was ever made for.
const UNKNOWN = "A".repeat(43);

// covers: AC-9
test("an unknown link shows the one Dead message, with no referrer and noindex", async ({
  page,
}) => {
  await page.goto(`/set-password/${UNKNOWN}`);
  await expect(
    page.getByText("This link has expired or was already used."),
  ).toBeVisible();
  await expect(page.locator('meta[name="referrer"]')).toHaveAttribute(
    "content",
    "no-referrer",
  );
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
    "content",
    "noindex, nofollow",
  );
});

// covers: AC-9
test("a malformed token gets the same Dead message", async ({ page }) => {
  await page.goto("/set-password/not-a-token");
  await expect(
    page.getByText("This link has expired or was already used."),
  ).toBeVisible();
});

// covers: AC-19 (the onAPIError errorURL path, for a state row that is gone)
test("a callback whose state row is gone lands on Sign in timed out, with a Sign in button", async ({
  page,
}) => {
  await page.goto("/api/auth/callback/authentik?state=bogus&code=x");
  await expect(page).toHaveURL(/\/auth\/error\?error=state_mismatch$/);
  await expect(page.getByText("Sign in timed out")).toBeVisible();
  await expect(
    page.getByText(
      "Your sign in expired before it finished. Sign in again to continue.",
    ),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
});

// covers: AC-19 (no state at all still reaches our page, not Better Auth's)
test("a callback with no state lands on our error page", async ({ page }) => {
  await page.goto("/api/auth/callback/authentik?code=x");
  await expect(page).toHaveURL(/\/auth\/error\?error=state_not_found$/);
  await expect(page.getByRole("main")).toBeVisible();
});
