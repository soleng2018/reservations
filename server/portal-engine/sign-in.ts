import "server-only";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright-core";
import type { PortalResetSignInReason } from "@/lib/db-enums";
import { CALL_TIMEOUT } from "@/lib/portal-reset/timing";
import { err, ok, type Result } from "@/lib/result";
import type { Session } from "./client";
import { secret, type Secret } from "./secret";

// The real sign in (spec 0023 AC-12, AC-13). A headless Chromium drives the
// portal's own sign in and Authentik's pages (selectors from the research
// prototype `00-login-and-read.mjs`), then the three headers are taken from
// the first same origin `/api/` request that carries `x-id-token`. Every
// later call is plain HTTP (`client.ts`). The browser stays open for the
// discovery pass and is closed by `session.close`. The Chromium sandbox stays
// on, and nothing here is written to disk. The password and the headers live
// in `Secret`s; no reply body, header, or page text is logged or returned.

export type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

export type SignedIn = {
  readonly session: Session;
  readonly browser: Browser;
  // The cookies of the signed in context, for a fresh context per page (AC-35).
  readonly state: Secret<StorageState>;
};

export type SignInInput = {
  readonly origin: string;
  readonly username: string;
  readonly password: Secret<string>;
};

export type Launch = () => Promise<Browser>;

const HEADER_NAMES = ["x-id-token", "x-nile-client", "x-requested-with"];
const LANDING_PATH = "/network-setup/wireless";

const STEP_MS = 30_000;
const SLOW_MS = 60_000;
// Authentik's password step renders before it accepts input.
const SETTLE_MS = 2_500;
const TOKEN_WAIT_MS = 30_000;

class SignInStop extends Error {
  readonly reason: PortalResetSignInReason;
  constructor(reason: PortalResetSignInReason) {
    super(`sign in stopped: ${reason}`);
    this.reason = reason;
  }
}

const isTimeout = (e: unknown): boolean =>
  e instanceof Error && e.name === "TimeoutError";

const onAuthentik = (page: Page): boolean => /authentik/.test(page.url());

// Run one browser step: a timeout is `timeout`, anything else `fallback`.
async function step<T>(
  fallback: PortalResetSignInReason,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof SignInStop) throw e;
    throw new SignInStop(isTimeout(e) ? "timeout" : fallback);
  }
}

// The first same origin `/api/` request that carries the token.
function captureHeaders(
  page: Page,
  origin: string,
): () => Record<string, string> | undefined {
  let captured: Record<string, string> | undefined;
  page.on("request", (req) => {
    if (captured !== undefined) return;
    const url = new URL(req.url());
    if (url.origin !== origin || !url.pathname.startsWith("/api/")) return;
    const headers = req.headers();
    if (!headers["x-id-token"]) return;
    captured = Object.fromEntries(
      HEADER_NAMES.flatMap((name) => {
        const value = headers[name];
        return value === undefined ? [] : [[name, value] as const];
      }),
    );
  });
  return () => captured;
}

// Playwright joins repeated headers with a newline, which `Headers` refuses,
// and the portal sends several `Set-Cookie` lines on some replies. The context
// keeps the cookies itself and no caller reads them, so they are dropped.
export const replyHeaders = (
  headers: Readonly<Record<string, string>>,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) => name.toLowerCase() !== "set-cookie",
    ),
  );

// API calls go through the signed in context's own request client. The
// portal's gateway redirects a plain fetch even with the same cookies, and the
// context keeps the session cookies fresh as the portal rotates them.
export function contextFetch(context: BrowserContext): typeof fetch {
  return async (input, init) => {
    const reply = await context.request.fetch(String(input), {
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      ...(typeof init?.body === "string" ? { data: init.body } : {}),
      maxRedirects: 0,
      failOnStatusCode: false,
      timeout: CALL_TIMEOUT,
    });
    const status = reply.status();
    const body = await reply.body();
    return new Response(
      [204, 205, 304].includes(status) ? null : new Uint8Array(body),
      {
        status,
        headers: replyHeaders(reply.headers()),
      },
    );
  };
}

async function drive(page: Page, input: SignInInput): Promise<void> {
  const { origin, username } = input;
  await step("portal_unreachable", () =>
    page.goto(origin, { waitUntil: "domcontentloaded", timeout: SLOW_MS }),
  );
  await step("portal_unreachable", async () => {
    await page.waitForSelector("#idp-discovery-username", {
      timeout: STEP_MS,
    });
    await page.fill("#idp-discovery-username", username);
    await page.click("#idp-discovery-submit");
    await page.waitForURL(/authentik/, { timeout: SLOW_MS });
  });
  // From here the pages are Authentik's: a page that does not show what we
  // expect means the account was refused.
  await step("idp_rejected", async () => {
    const uid = page.locator('input[name="uidField"]');
    await uid.waitFor({ timeout: STEP_MS });
    await uid.fill(username);
    await page.keyboard.press("Enter");
    await page
      .getByText("Password", { exact: true })
      .first()
      .waitFor({ timeout: STEP_MS });
    await page.waitForTimeout(SETTLE_MS);
    const box = page.locator('input[type="password"]').first();
    await box.click();
    await box.fill(input.password.reveal());
    await page.getByRole("button", { name: /continue/i }).click();
  });
  const left = await page
    .waitForURL((u) => !/authentik/.test(u.host), { timeout: SLOW_MS })
    .then(
      () => true,
      () => false,
    );
  // Still on Authentik after the password: the sign in said no.
  if (!left && onAuthentik(page)) throw new SignInStop("idp_rejected");
  if (!left) throw new SignInStop("timeout");
}

export async function signIn(
  input: SignInInput,
  launch: Launch = () => chromium.launch({ headless: true }),
): Promise<Result<SignedIn, PortalResetSignInReason>> {
  const browser = await launch().catch(() => undefined);
  if (browser === undefined) return err("browser_unavailable");
  const close = () => browser.close().catch(() => undefined);
  try {
    const context = await browser.newContext({
      viewport: { width: 1400, height: 900 },
    });
    const page = await context.newPage();
    const headers = captureHeaders(page, input.origin);
    await drive(page, input);
    // The landing page makes the portal send an API request with the token.
    await step("portal_unreachable", () =>
      page.goto(`${input.origin}${LANDING_PATH}`, {
        waitUntil: "domcontentloaded",
        timeout: SLOW_MS,
      }),
    );
    const deadline = TOKEN_WAIT_MS / 1000;
    for (let i = 0; i < deadline && headers() === undefined; i++) {
      await page.waitForTimeout(1000);
    }
    const found = headers();
    if (found === undefined) throw new SignInStop("token_missing");
    const state = await context.storageState();
    return ok({
      session: {
        origin: input.origin,
        headers: secret(found),
        fetch: contextFetch(context),
        close,
      },
      browser,
      state: secret(state),
    });
  } catch (e) {
    await close();
    if (e instanceof SignInStop) return err(e.reason);
    return err(isTimeout(e) ? "timeout" : "portal_unreachable");
  }
}
