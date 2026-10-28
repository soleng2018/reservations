import "server-only";
import { chromium } from "playwright-core";
import { err, ok, type Result } from "@/lib/result";

// Spec 0023 AC-40: the worker's start check. It launches Chromium once and
// closes it, like the email renderer check, so a worker image that cannot run
// the browser is found at deploy and not at the first reset. The message is
// the browser's own start up error (a missing library or a blocked sandbox),
// which holds no secret.
export async function checkBrowser(
  launch: () => Promise<{ close: () => Promise<void> }> = () =>
    chromium.launch({ headless: true }),
): Promise<Result<void, string>> {
  try {
    const browser = await launch();
    await browser.close();
    return ok(undefined);
  } catch (e) {
    return err(
      (e instanceof Error ? e.message : "unknown error").split("\n")[0] ??
        "unknown error",
    );
  }
}
