// Pure planning for `npm run authentik:setup` (spec 0003, AC-13): compare what
// Authentik has with what the app needs, and list the changes. No I/O here.

export const APP_SLUG = "hol";
export const APP_NAME = "HOL";
export const PROVIDER_NAME = "Provider for HOL";
export const ADMIN_GROUP = "hol-admins";
export const LEARNER_PATH = "hol/learners";
export const RECOVERY_FLOW_SLUG = "hol-recovery";
export const PROVISIONING_ACCOUNT = "hol-webapp-provisioning";
export const PROVISIONING_ROLE = "hol-webapp-provisioning";
// Better Auth 1.7 generic OAuth callback (core route), providerId `authentik`.
export const CALLBACK_PATH = "/api/auth/callback/authentik";

// Global permissions for the provisioning role (spec 0003 security model).
// Object level containment (never an admin, only `pod-*` groups) is the
// app's guard, since Authentik RBAC cannot express it.
export const PROVISIONING_PERMISSIONS: readonly string[] = [
  "authentik_core.view_user",
  "authentik_core.add_user",
  "authentik_core.change_user",
  "authentik_core.reset_user_password", // recovery link creation
  "authentik_core.view_group",
  "authentik_core.add_group",
  "authentik_core.delete_group",
  "authentik_core.add_user_to_group",
  "authentik_core.remove_user_from_group",
  "authentik_core.view_authenticatedsession",
  "authentik_core.delete_authenticatedsession",
].toSorted();

export type RedirectUri = {
  readonly matching_mode: "strict" | "regex";
  readonly url: string;
};

// One change to a field: what it is now and what it will become.
export type FieldChange = {
  readonly field: string;
  readonly from: unknown;
  readonly to: unknown;
};

export type ParsedUrls =
  | { readonly ok: true; readonly urls: readonly string[] }
  | { readonly ok: false; readonly error: string };

// APP_URLS is a comma separated list of origins (prod plus localhost).
export function parseAppUrls(raw: string): ParsedUrls {
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) return { ok: false, error: "APP_URLS is empty" };
  const bad = parts.filter((p) => {
    try {
      const u = new URL(p);
      return (
        !["http:", "https:"].includes(u.protocol) ||
        u.pathname !== "/" ||
        u.search !== "" ||
        u.hash !== ""
      );
    } catch {
      return true;
    }
  });
  if (bad.length > 0)
    return {
      ok: false,
      error: `APP_URLS entries must be bare origins: ${bad.join(", ")}`,
    };
  return {
    ok: true,
    urls: [...new Set(parts.map((p) => new URL(p).origin))].toSorted(),
  };
}

// The proxy in front of Authentik answers 403 to any request body holding a
// plain `http://` URL, so http origins (local dev) are sent as an anchored
// regex with escaped slashes. It still matches exactly that one URL.
const exactRegex = (url: string): string =>
  `^${url.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$`;

export const redirectUris = (
  appUrls: readonly string[],
): readonly RedirectUri[] =>
  appUrls.map((origin) => {
    const url = `${origin}${CALLBACK_PATH}`;
    return origin.startsWith("http:")
      ? { matching_mode: "regex", url: exactRegex(url) }
      : { matching_mode: "strict", url };
  });

// Order free comparison for arrays of primitives or plain objects.
const canonical = (v: unknown): string =>
  Array.isArray(v)
    ? JSON.stringify(v.map(canonical).toSorted())
    : v !== null && typeof v === "object"
      ? JSON.stringify(
          Object.keys(v)
            .toSorted()
            .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
        )
      : JSON.stringify(v);

export const sameValue = (a: unknown, b: unknown): boolean =>
  canonical(a) === canonical(b);

// Fields of `desired` whose value differs in `current` (missing counts as differing).
export const diffFields = (
  current: Readonly<Record<string, unknown>>,
  desired: Readonly<Record<string, unknown>>,
): readonly FieldChange[] =>
  Object.entries(desired)
    .filter(([field, to]) => !sameValue(current[field], to))
    .map(([field, to]) => ({ field, from: current[field], to }));

export type ProviderInputs = {
  readonly appUrls: readonly string[];
  readonly authorizationFlow: string;
  readonly invalidationFlow: string;
  readonly signingKey: string;
  readonly scopeMappings: readonly string[]; // openid, email, profile (profile carries groups)
};

export const desiredProvider = (i: ProviderInputs) => ({
  name: PROVIDER_NAME,
  client_type: "confidential",
  sub_mode: "user_id", // `sub` = Authentik user pk = users.authentik_user_pk
  issuer_mode: "per_provider",
  include_claims_in_id_token: true,
  authorization_flow: i.authorizationFlow,
  invalidation_flow: i.invalidationFlow,
  signing_key: i.signingKey,
  property_mappings: [...i.scopeMappings].toSorted(),
  redirect_uris: redirectUris(i.appUrls),
});

export type PermissionPlan = {
  readonly add: readonly string[];
  readonly remove: readonly string[];
};

export const planPermissions = (
  current: readonly string[],
  desired: readonly string[] = PROVISIONING_PERMISSIONS,
): PermissionPlan => ({
  add: desired.filter((p) => !current.includes(p)).toSorted(),
  remove: current.filter((p) => !desired.includes(p)).toSorted(),
});
