import { generateKeyPairSync } from "node:crypto";
import { expect, type Page, type Response } from "@playwright/test";
import { test } from "./admin-session";
import { haveSecrets } from "./authentik";
import { expectNoSeriousViolations } from "./axe";

// Feature 8 (spec 0006) in the browser: add, search, edit, replace, and
// delete an API key on /admin/api-keys against the real database, and prove
// the secret never comes back (AC-8). Each test removes the keys it created
// (names start with `e2e keys `), even when it fails. Needs the keyring
// (APP_ENCRYPTION_KEYS_FILE) in the dev server's env.
test.skip(!haveSecrets, "hol-test passwords are not on this machine");

const unique = () => crypto.randomUUID().slice(0, 8);
const MASK = "••••••••••••";

const rowOf = (page: Page, name: string) =>
  page.getByRole("row").filter({
    has: page.getByRole("cell", { name, exact: true }),
  });

// Skips the test when the dev server has no keyring (AC-9's state).
async function openPage(page: Page) {
  await page.goto("/admin/api-keys");
  const notConfigured = page.getByText("Encryption isn't configured.", {
    exact: false,
  });
  const add = page.getByRole("button", { name: "Add API key" });
  await expect(notConfigured.or(add)).toBeVisible();
  test.skip(
    await notConfigured.isVisible(),
    "the dev server has no encryption keyring",
  );
}

async function deleteKey(page: Page, name: string) {
  await rowOf(page, name)
    .getByRole("button", { name: `Delete ${name}` })
    .click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByText("Deleted.")).toBeVisible();
}

// Every body the server sends this page that could carry data: documents,
// RSC payloads, and Server Action results (not static JS or CSS).
const captureBodies = (page: Page) => {
  const bodies: Promise<string>[] = [];
  const isData = (r: Response) =>
    r.request().resourceType() === "document" ||
    r.request().method() === "POST" ||
    (r.headers()["content-type"] ?? "").includes("text/x-component");
  page.on("response", (r) => {
    if (isData(r)) bodies.push(r.text().catch(() => ""));
  });
  return async () => Promise.all(bodies);
};

let created: string[] = [];

test.beforeEach(() => {
  created = [];
});

test.afterEach(async ({ adminPage: page }) => {
  await page.goto("/admin/api-keys");
  for (const name of created)
    if ((await rowOf(page, name).count()) > 0) await deleteKey(page, name);
});

test("an admin adds, searches, edits, replaces, and deletes a key, and the secret never comes back", async ({
  adminPage: page,
}) => {
  const bodies = captureBodies(page);
  const name = `e2e keys ${unique()}`;
  const canary = `canary${unique()}${unique()}`;
  const replacement = `canary${unique()}${unique()}`;
  created.push(name);
  await openPage(page);

  // Add (AC-2): the key field is a write only password input.
  await page.getByRole("button", { name: "Add API key" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading")).toHaveText("Add API Key");
  const keyField = dialog.getByLabel("Key value");
  await expect(keyField).toHaveAttribute("type", "password");
  await expect(keyField).toHaveAttribute("autocomplete", "new-password");
  await expect(keyField).toHaveAttribute("placeholder", "Secret key or token");
  await dialog.getByLabel("Name").fill(name);
  await dialog.getByLabel("Base URL").fill("https://acme.okta.example/oauth2");
  await keyField.fill(canary);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(`Created ${name}.`)).toBeVisible();

  // The row (AC-1): mask, today's date, and only Edit and Delete.
  const row = rowOf(page, name);
  await expect(row).toContainText("IDP");
  await expect(row).toContainText("https://acme.okta.example/oauth2");
  await expect(row).toContainText(MASK);
  await expect(row).toContainText(/Changed \w{3}, \w{3} \d{1,2}/);
  await expect(row.getByRole("button")).toHaveCount(2);
  await expect(row.getByRole("button", { name: `Edit ${name}` })).toBeVisible();
  await expect(
    row.getByRole("button", { name: `Delete ${name}` }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /reveal|show|copy/i }),
  ).toHaveCount(0);

  // Search on base URL (AC-1).
  const search = page.getByRole("searchbox");
  await search.fill("acme.okta.example/oauth2");
  await expect(row).toHaveCount(1);
  await search.fill("no such key anywhere");
  await expect(page.getByText("No API keys match your search.")).toBeVisible();
  await search.fill("");

  // Edit, keeping the key (AC-4).
  await row.getByRole("button", { name: `Edit ${name}` }).click();
  await expect(dialog.getByRole("heading")).toHaveText("Edit API Key");
  await expect(dialog.getByLabel("Name")).toHaveValue(name);
  await expect(dialog.getByLabel("Base URL")).toHaveValue(
    "https://acme.okta.example/oauth2",
  );
  await expect(keyField).toHaveValue("");
  await expect(keyField).toHaveAttribute(
    "placeholder",
    "Leave blank to keep the current key",
  );
  await expect(dialog.getByText(/^Last changed /)).toBeVisible();
  await dialog.getByLabel("Base URL").fill("https://acme.okta.example/v2");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(`Updated ${name}.`)).toBeVisible();
  await expect(row).toContainText("https://acme.okta.example/v2");

  // A refused save keeps every typed value, the key included (AC-3).
  await row.getByRole("button", { name: `Edit ${name}` }).click();
  await dialog.getByLabel("Base URL").fill("https://acme.okta.example/?k=1");
  await keyField.fill(replacement);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(
    dialog.getByText("Remove the query string from the URL."),
  ).toBeVisible();
  await expect(keyField).toHaveValue(replacement);

  // Replace the key (AC-4).
  await dialog.getByLabel("Base URL").fill("https://acme.okta.example/v2");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(`Updated ${name}.`)).toBeVisible();
  await expect(dialog).toHaveCount(0);

  // Reopen: the key field is empty again.
  await row.getByRole("button", { name: `Edit ${name}` }).click();
  await expect(keyField).toHaveValue("");
  await dialog.getByRole("button", { name: "Cancel" }).click();

  // Delete (AC-6).
  await deleteKey(page, name);
  await expect(rowOf(page, name)).toHaveCount(0);
  await page.reload();
  await expect(rowOf(page, name)).toHaveCount(0);

  // AC-8: neither secret nor any ciphertext in what the server sent.
  const sent = (await bodies()).join("\n");
  expect(sent.length).toBeGreaterThan(0);
  expect(sent).not.toContain(canary);
  expect(sent).not.toContain(replacement);
  expect(sent).not.toMatch(/\bv1:[A-Za-z0-9_]{1,32}:[A-Za-z0-9_-]{16}:/);
});

test("a duplicate name, an http URL, and an empty key show field errors", async ({
  adminPage: page,
}) => {
  const name = `e2e keys ${unique()}`;
  created.push(name);
  await openPage(page);

  const dialog = page.getByRole("dialog");
  const add = async (n: string, url: string, key: string) => {
    await page.getByRole("button", { name: "Add API key" }).click();
    await dialog.getByLabel("Name").fill(n);
    await dialog.getByLabel("Base URL").fill(url);
    await dialog.getByLabel("Key value").fill(key);
    await dialog.getByRole("button", { name: "Save" }).click();
  };

  await add(name, "https://ai.example", "k");
  await expect(page.getByText(`Created ${name}.`)).toBeVisible();

  await add(name.toUpperCase(), "http://ai.example", "");
  await expect(dialog.getByText("Enter an https:// URL.")).toBeVisible();
  await expect(dialog.getByText("Enter the key.")).toBeVisible();
  await dialog.getByLabel("Base URL").fill("https://ai.example");
  await dialog.getByLabel("Key value").fill("k");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(
    dialog.getByText("An API key with this name already exists."),
  ).toBeVisible();
  await expect(dialog.getByLabel("Name")).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(rowOf(page, name)).toHaveCount(1);
});

// covers: AC-3
test("a URL with credentials and a 4097 character key are refused, the key kept whole", async ({
  adminPage: page,
}) => {
  await openPage(page);
  const dialog = page.getByRole("dialog", { name: "Add API Key" });
  const keyField = dialog.getByLabel("Key value");
  const long = `canary${unique()}`.padEnd(4097, "x");

  await page.getByRole("button", { name: "Add API key" }).click();
  await dialog.getByLabel("Name").fill(`e2e keys ${unique()}`);
  await dialog.getByLabel("Base URL").fill("https://u:p@acme.okta.example");
  await keyField.fill(long);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(
    dialog.getByText("Remove credentials from the URL."),
  ).toBeVisible();
  await expect(dialog.getByText("Use at most 4096 characters.")).toBeVisible();
  // No maxLength on the key: a pasted secret is never cut short.
  await expect(keyField).toHaveValue(long);
  await dialog.getByRole("button", { name: "Cancel" }).click();
});

// covers: AC-1
test("an AI key is listed with its type, and search matches name and type", async ({
  adminPage: page,
}) => {
  // Hex suffixes and these hosts never spell "ai", so only the type does.
  const idp = `e2e keys ${unique()}`;
  const ai = `e2e keys ${unique()}`;
  created.push(idp, ai);
  await openPage(page);

  const dialog = page.getByRole("dialog", { name: "Add API Key" });
  await page.getByRole("button", { name: "Add API key" }).click();
  await dialog.getByLabel("Name").fill(idp);
  await dialog.getByLabel("Base URL").fill("https://idp.example");
  await dialog.getByLabel("Key value").fill("k");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(`Created ${idp}.`)).toBeVisible();

  await page.getByRole("button", { name: "Add API key" }).click();
  await dialog.getByLabel("Name").fill(ai);
  await dialog.getByRole("combobox").click();
  await page.getByRole("option", { name: "AI", exact: true }).click();
  await dialog.getByLabel("Base URL").fill("https://llm.example");
  await dialog.getByLabel("Key value").fill("k");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(`Created ${ai}.`)).toBeVisible();
  await expect(rowOf(page, ai).getByRole("cell").nth(1)).toHaveText("AI");
  await expect(rowOf(page, idp).getByRole("cell").nth(1)).toHaveText("IDP");

  const search = page.getByRole("searchbox");
  await search.fill("AI");
  await expect(rowOf(page, ai)).toHaveCount(1);
  await expect(rowOf(page, idp)).toHaveCount(0);

  await search.fill(idp.toUpperCase());
  await expect(rowOf(page, idp)).toHaveCount(1);
  await expect(rowOf(page, ai)).toHaveCount(0);
});

// covers: spec 0013 AC-1 to AC-3, AC-5 (the GOOGLE key)
test("a GOOGLE key swaps the fields, refuses a bad file, and never echoes the key", async ({
  adminPage: page,
}) => {
  test.setTimeout(60_000);
  const name = `e2e keys ${unique()}`;
  created.push(name);
  await openPage(page);
  const bodies = captureBodies(page);

  await page.getByRole("button", { name: "Add API key" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill(name);
  await dialog.getByRole("combobox", { name: "Type" }).click();
  await page.getByRole("option", { name: "GOOGLE", exact: true }).click();
  await expect(dialog.getByLabel("Base URL")).toHaveCount(0);
  await expect(dialog.getByLabel("Key value")).toHaveCount(0);
  await expect(dialog.getByLabel("Key file")).toBeVisible();
  await dialog.getByLabel("Sender mailbox").fill("labs@nile-test.invalid");
  await dialog
    .getByLabel("Calendar ID")
    .fill("c_e2e@group.calendar.google.com");

  // AC-1: no file.
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog.getByText("Choose the key file.")).toBeVisible();

  // AC-3: not a service account key; AC-26: an OAuth client file is named.
  await dialog.getByLabel("Key file").setInputFiles({
    name: "notes.json",
    mimeType: "application/json",
    buffer: Buffer.from("{not json"),
  });
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(
    dialog.getByText("This isn't a Google service account key file (.json)."),
  ).toBeVisible();
  await dialog.getByLabel("Key file").setInputFiles({
    name: "client_secret.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ web: { client_id: "x" } })),
  });
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(
    dialog.getByText(
      "This is an OAuth client file. Choose Google sign in as the sign in method, or use a service account key.",
    ),
  ).toBeVisible();

  // AC-2: a well formed key Google has never issued. The real token call
  // refuses it (or Google can't be reached); either way nothing is saved.
  const canary = `canary${unique()}${unique()}`;
  const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  await dialog.getByLabel("Key file").setInputFiles({
    name: "hol-key.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        type: "service_account",
        project_id: "hol-e2e",
        private_key_id: canary,
        private_key: privateKey,
        client_email: `e2e-${unique()}@hol-e2e.iam.gserviceaccount.com`,
        client_id: "100000000000000000001",
      }),
    ),
  });
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(
    dialog
      .getByText(
        /^Google (didn't accept|refused) this key for labs@nile-test\.invalid/,
      )
      .or(
        dialog.getByText("Couldn't reach Google to check the key. Try again."),
      ),
  ).toBeVisible({ timeout: 30_000 });
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(rowOf(page, name)).toHaveCount(0);

  const sent = (await bodies()).join("\n");
  expect(sent).not.toContain(canary);
  expect(sent).not.toContain("PRIVATE KEY");
});

// covers: spec 0013 AC-25 to AC-28 (Google sign in). Playwright can't drive
// Google's own sign in, so this covers the dialog only: the fields switch
// with the method, a sign in starts (no Google call: it only builds the
// address), and a wrong pasted address is refused before any exchange.
test("Google sign in swaps the fields, starts a sign in, and refuses a wrong address", async ({
  adminPage: page,
}) => {
  const name = `e2e keys ${unique()}`;
  created.push(name);
  await openPage(page);

  await page.getByRole("button", { name: "Add API key" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill(name);
  await dialog.getByRole("combobox", { name: "Type" }).click();
  await page.getByRole("option", { name: "GOOGLE", exact: true }).click();
  const methods = dialog.getByRole("radiogroup", { name: "Sign in method" });
  await expect(
    methods.getByRole("radio", { name: "Service account (Workspace)" }),
  ).toBeChecked();
  await methods
    .getByRole("radio", {
      name: "Google sign in (personal Gmail, for testing)",
    })
    .click();
  await expect(dialog.getByLabel("Key file")).toHaveCount(0);
  await expect(dialog.getByLabel("Sender mailbox")).toHaveCount(0);
  await expect(dialog.getByLabel("OAuth client file")).toBeVisible();
  await expect(dialog.getByLabel("Google sign in address")).toHaveCount(0);
  await dialog
    .getByLabel("Calendar ID")
    .fill("c_e2e@group.calendar.google.com");

  // AC-28 steps 2 and 3: nothing chosen, nothing pasted.
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog.getByText("Choose the OAuth client file.")).toBeVisible();
  await expect(
    dialog.getByText("Sign in with Google first, then paste the address."),
  ).toBeVisible();
  await expectNoSeriousViolations(page);

  // AC-26, AC-27: a Desktop app client file starts the sign in.
  await dialog.getByLabel("OAuth client file").setInputFiles({
    name: "client_secret_desktop.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        installed: {
          client_id: "100000000001-e2e.apps.googleusercontent.com",
          client_secret: `GOCSPX-${unique()}`,
        },
      }),
    ),
  });
  await dialog.getByRole("button", { name: "Sign in with Google" }).click();
  const open = dialog.getByRole("link", { name: "Open Google sign in" });
  await expect(open).toBeVisible();
  await expect(open).toHaveAttribute("target", "_blank");
  await expect(open).toHaveAttribute("rel", "noopener noreferrer");
  const href = new URL((await open.getAttribute("href")) ?? "");
  expect(href.origin + href.pathname).toBe(
    "https://accounts.google.com/o/oauth2/v2/auth",
  );
  expect(href.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:47613/");
  await expect(
    dialog.getByText("Sign in with Google first, then paste the address."),
  ).toHaveCount(0);
  await expectNoSeriousViolations(page);

  // AC-28 step 3: an address from somewhere else never reaches Google.
  await dialog
    .getByLabel("Google sign in address")
    .fill("http://localhost:47613/?state=x&code=y");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(
    dialog.getByText("Paste the full address from the page Google opened."),
  ).toBeVisible();
  await expect(dialog.getByLabel("Google sign in address")).toBeFocused();
  await page.screenshot({
    path: "e2e/screenshots/1280-api-keys-google-sign-in.png",
  });
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(rowOf(page, name)).toHaveCount(0);
});
