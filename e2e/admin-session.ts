import {
  test as base,
  expect,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
} from "@playwright/test";
import { ADMIN_ENTRY, admin, signIn } from "./authentik";

type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

// One real Authentik sign in per run (workers: 1), reused by every admin
// test through its storage state. A lazy cache, like the app's own.
let state: Promise<StorageState> | undefined;

const signInOnce = async (browser: Browser): Promise<StorageState> => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, ADMIN_ENTRY, admin);
  await expect(page).toHaveURL(/\/admin\/testbed-types$/, { timeout: 30_000 });
  const saved = await context.storageState();
  await context.close();
  return saved;
};

// A fresh browser context already signed in as hol-test-admin.
export async function adminContext(
  browser: Browser,
  options: BrowserContextOptions = {},
): Promise<BrowserContext> {
  state ??= signInOnce(browser);
  return browser.newContext({ ...options, storageState: await state });
}

// `adminPage`: a page in a signed in admin context, closed after the test.
export const test = base.extend<{ adminPage: Page }>({
  adminPage: async ({ browser }, provide) => {
    const context = await adminContext(browser);
    await provide(await context.newPage());
    await context.close();
  },
});
