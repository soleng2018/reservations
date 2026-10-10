import "server-only";
import { z } from "zod";

// Only membership in this Authentik group grants admin (spec 0003).
export const ADMIN_GROUP = "hol-admins";

// The OIDC claims sign in relies on (Authentik `profile` and `email` scopes).
// `sub` is the Authentik user pk (provider sub_mode = user_id).
export const signInClaimsSchema = z.object({
  sub: z.string().regex(/^\d+$/),
  email: z.string().trim().min(1).optional(),
  name: z.string().trim().optional(),
  groups: z.array(z.string()).default([]),
});

export type SignInClaims = z.infer<typeof signInClaimsSchema>;

// The `users` row matched for this identity: by `authentik_user_pk`, or, for
// an admin only, by email the first time.
export type SignInRow = {
  readonly id: string;
  readonly role: "admin" | "learner";
  readonly status: "active" | "deactivated";
  readonly hasBookings: boolean;
};

export type SignInDecision =
  | { readonly kind: "admin"; readonly rowId: string | undefined }
  | { readonly kind: "learner"; readonly rowId: string }
  | { readonly kind: "refused_unknown" }
  | { readonly kind: "refused_deactivated" }
  | { readonly kind: "refused_no_email" }
  | { readonly kind: "refused_learner_is_admin"; readonly rowId: string };

export type RefusalKind = Exclude<SignInDecision["kind"], "admin" | "learner">;

export const isAdminClaim = (claims: SignInClaims): boolean =>
  claims.groups.includes(ADMIN_GROUP);

// Decided on every sign in (AC-2, AC-10). Pure: the caller loads the row.
export function resolveSignIn(
  claims: SignInClaims,
  row: SignInRow | undefined,
): SignInDecision {
  if (isAdminClaim(claims)) {
    if (!claims.email) return { kind: "refused_no_email" };
    if (row && (row.role === "learner" || row.hasBookings))
      return { kind: "refused_learner_is_admin", rowId: row.id };
    if (row?.status === "deactivated") return { kind: "refused_deactivated" };
    return { kind: "admin", rowId: row?.id };
  }
  if (!row) return { kind: "refused_unknown" };
  if (row.status === "deactivated") return { kind: "refused_deactivated" };
  return { kind: "learner", rowId: row.id };
}

// The `reason` shown by /auth/error. Admin specific refusals read as a plain
// "not authorized", with no admin hints (AC-2).
export type ErrorReason =
  "unknown" | "deactivated" | "unavailable" | "not_authorized";

export function refusalReason(kind: RefusalKind): ErrorReason {
  switch (kind) {
    case "refused_unknown":
      return "unknown";
    case "refused_deactivated":
      return "deactivated";
    case "refused_no_email":
    case "refused_learner_is_admin":
      return "not_authorized";
    default: {
      const never: never = kind;
      throw new Error(`unhandled refusal ${String(never)}`);
    }
  }
}
