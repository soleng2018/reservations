// Pure planning for `npm run authentik:setup` (spec 0003, AC-13): compare what
// Authentik has with what the app needs, and list the changes. No I/O here.

export const APP_SLUG = "hol";
export const APP_NAME = "HOL";
export const PROVIDER_NAME = "Provider for HOL";
export const ADMIN_GROUP = "hol-admins";
export const LEARNER_PATH = "hol/learners";
export const RECOVERY_FLOW_SLUG = "hol-recovery";
// HOL's own authorization flow (AC-17): no stages, no policy bindings, used
// by the HOL provider only, so the deny on the default flows never reaches it.
export const HOL_AUTHORIZATION_FLOW_SLUG = "hol-authorization";
// Sign out ends Authentik sessions through the API (AC-12), so the provider
// keeps Authentik's default invalidation flow.
export const DEFAULT_INVALIDATION_FLOW_SLUG =
  "default-provider-invalidation-flow";
// Made by an earlier version of this script; removed once nothing uses it.
export const LEGACY_INVALIDATION_FLOW_SLUG = "hol-invalidation";
export const LEGACY_INVALIDATION_STAGE = "hol-invalidation-logout";
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

// Per origin: the sign in callback only. Sign out never sends the browser
// through Authentik (AC-12), so no post logout targets are registered.
export const redirectUris = (
  appUrls: readonly string[],
): readonly RedirectUri[] =>
  appUrls.map((origin): RedirectUri => {
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
  readonly authorizationFlow: string; // hol-authorization
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

// ---- Learner isolation (AC-17) ----------------------------------------------

export const ISOLATION_POLICY = "hol-learner-isolation";
// Every app except HOL opens through one of these, signed in or not. The
// login flow (default-authentication-flow) is deliberately not bound.
export const AUTHORIZATION_FLOWS: readonly string[] = [
  "default-provider-authorization-implicit-consent",
  "default-provider-authorization-explicit-consent",
];

export const desiredHolAuthorizationFlow = {
  name: "HOL authorization",
  slug: HOL_AUTHORIZATION_FLOW_SLUG,
  title: "Redirecting to %(app)s",
  designation: "authorization",
  authentication: "require_authenticated",
  policy_engine_mode: "any",
  denied_action: "message_continue",
} as const;

// The expression the setup script owns (spec 0003, Feature design). It reads
// only the user, never the app, so Authentik's per flow, per user result
// cache can never carry a pass from one app to another.
export const isolationExpression = (): string =>
  [
    "# Deny every booking created learner on the shared default flows.",
    "# HOL itself authorizes through hol-authorization, which has no binding.",
    'path = getattr(request.user, "path", "") or ""',
    `return not (path == "${LEARNER_PATH}" or path.startswith("${LEARNER_PATH}/"))`,
  ].join("\n");

export const ISOLATION_BINDING_SETTINGS = {
  order: 0,
  enabled: true,
  negate: false,
  timeout: 30,
  failure_result: false,
} as const;

export const desiredIsolationBinding = (flowPk: string, policyPk: string) => ({
  target: flowPk,
  policy: policyPk,
  ...ISOLATION_BINDING_SETTINGS,
});

export type AuthorizationFlowState = {
  readonly slug: string;
  readonly policy_engine_mode: string;
  readonly denied_action: string;
  // Policy bindings on the flow (stage bindings are separate in Authentik).
  readonly bindings: readonly { readonly policy: string | null }[];
};

// Why binding the isolation policy to this flow would not hold. Under `any`,
// a second passing binding masks our deny, so the flow must hold no other
// policy binding; a denial must stop on Authentik's page.
export const isolationFlowProblems = (
  flow: AuthorizationFlowState,
  policyPk: string | undefined,
): readonly string[] => [
  ...(flow.policy_engine_mode === "any"
    ? []
    : [
        `${flow.slug}: policy_engine_mode is ${flow.policy_engine_mode}, expected any`,
      ]),
  ...(flow.denied_action === "message_continue"
    ? []
    : [
        `${flow.slug}: denied_action is ${flow.denied_action}, expected message_continue`,
      ]),
  ...(flow.bindings.some((b) => b.policy === null || b.policy !== policyPk)
    ? [`${flow.slug}: has a binding other than ${ISOLATION_POLICY}`]
    : []),
];

// Why hol-authorization would not keep HOL open for learners: it must be an
// authorization flow with nothing bound to it, stages or policies.
export const holFlowProblems = (flow: {
  readonly designation: string;
  readonly policyBindings: number;
  readonly stageBindings: number;
}): readonly string[] => [
  ...(flow.designation === "authorization"
    ? []
    : [
        `${HOL_AUTHORIZATION_FLOW_SLUG}: designation is ${flow.designation}, expected authorization`,
      ]),
  ...(flow.policyBindings === 0
    ? []
    : [
        `${HOL_AUTHORIZATION_FLOW_SLUG}: has ${flow.policyBindings} policy binding(s)`,
      ]),
  ...(flow.stageBindings === 0
    ? []
    : [
        `${HOL_AUTHORIZATION_FLOW_SLUG}: has ${flow.stageBindings} stage binding(s)`,
      ]),
];

// Providers isolation does not cover: their authorization flow is neither a
// default flow nor hol-authorization, so the script warns about them (and
// never edits them).
export const uncoveredProviders = (
  providers: readonly {
    readonly name: string;
    readonly authorization_flow: string;
  }[],
  coveredFlowPks: readonly string[],
): readonly { readonly name: string; readonly authorization_flow: string }[] =>
  providers.filter((p) => !coveredFlowPks.includes(p.authorization_flow));

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
