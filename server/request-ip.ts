import "server-only";
import { trustProxyHeaders } from "@/server/env";

// The client IP for rate limits (spec 0004). CF-Connecting-IP only when every
// request arrives through the Cloudflare Tunnel; otherwise anyone could forge
// it, so all requests share the one `untrusted` bucket (best effort).
export function clientIp(
  headers: Headers,
  trust: boolean = trustProxyHeaders(),
): string {
  if (!trust) return "untrusted";
  return headers.get("cf-connecting-ip")?.trim() || "untrusted";
}
