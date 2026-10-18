import { createHash, randomBytes } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { test } from "./admin-session";
import { haveSecrets } from "./authentik";
import { haveDb, withDb } from "./db";

// Feature 16 (spec 0014) in the browser, against the real database and
// Authentik: a new learner's set password link opens the app's own page,
// Set my password goes through Authentik's hol-recovery, and the learner
// lands on /reservations signed in. The link then shows Already set, and an
// unknown link shows the one Dead message. Each run leaves one
// `dev-setpw-…@nile-test.invalid` learner behind, by design.
test.skip(
  !haveSecrets || !haveDb,
  "hol-test passwords or .env.local are not on this machine",
);

const run = crypto.randomUUID().slice(0, 8);
const name = `Dev Setpw ${run}`;
const email = `dev-setpw-${run}@nile-test.invalid`;

async function addLearner(page: Page) {
  await page.goto("/admin/users");
  await page.getByRole("button", { name: "Add user" }).click();
  const add = page.getByRole("dialog");
  await add.getByLabel("Full name").fill(name);
  await add.getByLabel("Company name").fill("Nile e2e");
  await add.getByLabel("Email address").fill(email);
  await add.getByRole("combobox", { name: "Timezone", exact: true }).click();
  const zone = page.getByRole("option", {
    name: "America/Toronto",
    exact: true,
  });
  await zone.scrollIntoViewIfNeeded();
  await zone.click();
  await add.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(`Added ${name}.`)).toBeVisible({
    timeout: 30_000,
  });
}

// What the worker writes when it sends a welcome, with a token we know.
async function sentLink(): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(token).digest();
  await withDb(async (c) => {
    const user = await c.query<{ id: string }>(
      "select id from hol_app.users where lower(email) = $1",
      [email],
    );
    const userId = user.rows[0]?.id;
    expect(userId).toBeTruthy();
    const row = await c.query<{ id: string }>(
      `insert into hol_app.email_messages
         (user_id, kind, to_address, sent_to, subject, details, status, sent_at)
       values ($1, 'welcome', $2, $2, 'Set your password for Nile Hands-On Labs',
         jsonb_build_object('name', $3::text,
           'expiresAt', to_char((now() + interval '72 hours') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'timeZone', 'America/Toronto'),
         'sent', now())
       returning id`,
      [userId, email, name],
    );
    await c.query(
      `insert into hol_app.set_password_links
         (user_id, email_message_id, token_hash, email, expires_at)
       values ($1, $2, $3, $4, now() + interval '72 hours')`,
      [userId, row.rows[0]?.id, hash, email],
    );
  });
  return token;
}

// covers: spec 0014 AC-9, AC-10, AC-11, AC-12
test("a new learner's link sets a password and lands them signed in", async ({
  adminPage,
  browser,
}) => {
  test.setTimeout(120_000);
  await addLearner(adminPage);
  const token = await sentLink();
  const password = `E2e-${randomBytes(9).toString("base64url")}`;

  const learner = await browser.newContext();
  const page = await learner.newPage();
  await page.goto(`/set-password/${token}`);
  await expect(
    page.getByRole("heading", { level: 1, name: "Set your password" }),
  ).toBeVisible();
  await expect(page.getByText(`for ${email}`)).toBeVisible();
  await expect(
    page.locator('meta[name="referrer"][content="no-referrer"]'),
  ).toHaveCount(1);
  await page.getByRole("button", { name: "Set my password" }).click();

  // Authentik's hol-recovery: the password twice.
  const fields = page.getByLabel(/password/i);
  await expect(fields.first()).toBeVisible({ timeout: 20_000 });
  await fields.nth(0).fill(password);
  await fields.nth(1).fill(password);
  await page.getByRole("button", { name: /continue/i }).click();

  await expect(page).toHaveURL(/\/reservations$/, { timeout: 30_000 });
  await expect(
    page.getByRole("heading", { level: 1, name: "Welcome back, Dev" }),
  ).toBeVisible();

  // AC-12: the link doesn't start the flow again.
  await page.goto(`/set-password/${token}`);
  await expect(
    page.getByRole("heading", { name: "Your password is already set." }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  await learner.close();
});

// covers: spec 0014 AC-9
test("an unknown link shows the one Dead message and the resend form", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`/set-password/${randomBytes(32).toString("base64url")}`);
  await expect(
    page.getByRole("heading", {
      name: "This link has expired or was already used.",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Didn't get the set password email?" }),
  ).toBeVisible();
  await context.close();
});
