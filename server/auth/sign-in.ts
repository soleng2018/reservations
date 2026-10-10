import "server-only";
import { sql, type Kysely } from "kysely";
import { UserRole, UserStatus } from "@/lib/db-enums";
import { audit } from "@/server/audit";
import type { DB } from "@/server/db/types";
import {
  isAdminClaim,
  refusalReason,
  resolveSignIn,
  signInClaimsSchema,
  type ErrorReason,
  type SignInClaims,
  type SignInRow,
} from "./resolve-sign-in";

export const AUTHENTIK_PROVIDER_ID = "authentik";

async function loadRow(
  db: Kysely<DB>,
  claims: SignInClaims,
): Promise<SignInRow | undefined> {
  const pk = Number(claims.sub);
  const base = db
    .selectFrom("users")
    .select((eb) => [
      "users.id",
      "users.role",
      "users.status",
      eb
        .exists(
          eb
            .selectFrom("bookings")
            .select("bookings.id")
            .whereRef("bookings.user_id", "=", "users.id"),
        )
        .as("has_bookings"),
    ]);
  const byPk = await base
    .where("authentik_user_pk", "=", pk)
    .executeTakeFirst();
  // Email only links an admin's row the first time (spec 0003 value sourcing).
  const row =
    byPk ??
    (isAdminClaim(claims) && claims.email
      ? await base
          .where(sql<string>`lower(email)`, "=", claims.email.toLowerCase())
          .where("authentik_user_pk", "is", null)
          .executeTakeFirst()
      : undefined);
  return (
    row && {
      id: row.id,
      role: UserRole.parse(row.role),
      status: UserStatus.parse(row.status),
      hasBookings: Boolean(row.has_bookings),
    }
  );
}

// `user.validateUserInfo` for the Authentik provider: runs before Better Auth
// writes any row, on first and returning sign ins. Returns the refusal reason,
// or undefined to let the sign in continue (AC-2, AC-10).
export async function validateSignIn(
  db: Kysely<DB>,
  profile: Readonly<Record<string, unknown>> | undefined,
): Promise<ErrorReason | undefined> {
  const parsed = signInClaimsSchema.safeParse(profile ?? {});
  if (!parsed.success) {
    console.warn("sign in: unusable claims", parsed.error.issues);
    return "not_authorized";
  }
  const claims = parsed.data;
  const decision = resolveSignIn(claims, await loadRow(db, claims));
  const pk = Number(claims.sub);

  switch (decision.kind) {
    case "admin":
      await db.transaction().execute(async (trx) => {
        if (decision.rowId)
          await trx
            .updateTable("users")
            .set({ role: "admin", authentik_user_pk: pk })
            .where("id", "=", decision.rowId)
            .execute();
        else
          await trx
            .insertInto("users")
            .values({
              role: "admin",
              name: claims.name || claims.email || `Admin ${pk}`,
              company: "Nile",
              email: claims.email ?? "", // present: resolveSignIn refuses otherwise
              timezone: "UTC",
              authentik_user_pk: pk,
            })
            .execute();
      });
      return undefined;
    case "learner":
      // Someone removed from hol-admins signs in as a learner from now on.
      await db
        .updateTable("users")
        .set({ role: "learner" })
        .where("id", "=", decision.rowId)
        .where("role", "<>", "learner")
        .execute();
      return undefined;
    case "refused_no_email":
    case "refused_learner_is_admin":
      await audit(db, {
        actorUserId: null,
        action: "admin.sign_in_refused",
        targetType: "user",
        targetId:
          decision.kind === "refused_learner_is_admin"
            ? decision.rowId
            : `authentik:${pk}`,
        summary:
          decision.kind === "refused_no_email"
            ? "Admin sign in refused: no email claim"
            : "Admin sign in refused: this account is a learner",
      });
      return refusalReason(decision.kind);
    case "refused_unknown":
    case "refused_deactivated":
      console.info(`sign in refused (${decision.kind}) for authentik:${pk}`);
      return refusalReason(decision.kind);
    default: {
      const never: never = decision;
      throw new Error(`unhandled decision ${JSON.stringify(never)}`);
    }
  }
}

export type SessionHours = { readonly admin: number; readonly learner: number };

// `databaseHooks.session.create.before`: links the row, marks a learner's
// email verified on first sign in, and sets the role's fixed session length
// (AC-7, AC-11). Returns the expiry, or undefined to refuse the session.
export async function onSessionCreate(
  db: Kysely<DB>,
  authUserId: string,
  hours: SessionHours,
): Promise<Date | undefined> {
  const account = await db
    .selectFrom("hol_auth.account")
    .select("accountId")
    .where("userId", "=", authUserId)
    .where("providerId", "=", AUTHENTIK_PROVIDER_ID)
    .executeTakeFirst();
  if (!account) return undefined;

  return db.transaction().execute(async (trx) => {
    const row = await trx
      .updateTable("users")
      .set((eb) => ({
        auth_user_id: authUserId,
        email_verified_at: eb
          .case()
          .when("role", "=", "learner")
          .then(sql<Date>`coalesce(email_verified_at, now())`)
          .else(eb.ref("email_verified_at"))
          .end(),
        set_password_pending: eb
          .case()
          .when("role", "=", "learner")
          .then(false)
          .else(eb.ref("set_password_pending"))
          .end(),
      }))
      .where("authentik_user_pk", "=", Number(account.accountId))
      .where("status", "=", "active")
      .returning(["id", "role", sql<Date>`now()`.as("now")])
      .executeTakeFirst();
    // No row or deactivated: validateSignIn refused already; never a session.
    if (!row) return undefined;

    const role = UserRole.parse(row.role);
    if (role === "admin")
      await audit(trx, {
        actorUserId: row.id,
        action: "admin.signed_in",
        targetType: "user",
        targetId: row.id,
        summary: "Admin signed in",
      });
    else console.info(`learner signed in: ${row.id}`);

    return new Date(row.now.getTime() + hours[role] * 3_600_000);
  });
}
