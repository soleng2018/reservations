import hosts from "./portal-hosts.json";

// Spec 0023 AC-43: a testbed's `portal_url` is used only if it is https, has
// no username or password, and its host is, or ends with a dot and, one of
// the allowed portal hosts. The sign in uses the origin only, so the
// automation password can never be typed into a page a typo pointed
// elsewhere. Safe on both sides.

export const PORTAL_HOSTS: readonly string[] = hosts;

const allowed = (host: string): boolean =>
  PORTAL_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));

// The origin to sign in to, or null when the address is not allowed.
export function portalOrigin(portalUrl: string | null): string | null {
  if (portalUrl === null) return null;
  try {
    const url = new URL(portalUrl);
    if (url.protocol !== "https:") return null;
    if (url.username !== "" || url.password !== "") return null;
    return allowed(url.hostname.toLowerCase()) ? url.origin : null;
  } catch {
    return null;
  }
}

// Spec 0023 AC-16: lower case, letters and digits only.
export const tenantKey = (text: string): string =>
  text.toLowerCase().replace(/[^a-z0-9]/g, "");

// `Nile Workshop-1`, `Nile Workshop 1`, and `nileworkshop-1.com` all give
// `nileworkshop1`: the tenant is compared with the domain's first label.
export function tenantMatches(tenantName: string, domain: string): boolean {
  const label = domain.split(".")[0] ?? "";
  const key = tenantKey(label);
  return key !== "" && tenantKey(tenantName) === key;
}
