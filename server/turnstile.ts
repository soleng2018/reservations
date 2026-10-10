import "server-only";
import { z } from "zod";
import { err, ok, type Result } from "@/lib/result";
import { turnstileEnv } from "@/server/env";

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

const verifyResponse = z.object({ success: z.boolean() });

// Server side check of a Turnstile token (spec 0001), before any Authentik
// call or job. "failed" covers a missing, used, or forged token.
export async function verifyTurnstile(
  token: string,
  ip: string | undefined,
): Promise<Result<void, "failed" | "unavailable">> {
  if (!token) return err("failed");
  const body = new URLSearchParams({
    secret: turnstileEnv().TURNSTILE_SECRET_KEY,
    response: token,
    ...(ip ? { remoteip: ip } : {}),
  });
  try {
    const res = await fetch(SITEVERIFY, {
      method: "POST",
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return err("unavailable");
    const parsed = verifyResponse.safeParse(await res.json());
    if (!parsed.success) return err("unavailable");
    return parsed.data.success ? ok(undefined) : err("failed");
  } catch (e) {
    console.error("turnstile: verify failed", e);
    return err("unavailable");
  }
}
