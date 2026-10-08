import "server-only";
import { UserTypeEnum } from "@goauthentik/api/dist/esm/index.js";
import { sql, type Kysely } from "kysely";
import { err, ok, type Result } from "@/lib/result";
import { audit } from "@/server/audit";
import type { DB } from "@/server/db/types";
import { LEARNER_PATH } from "@/scripts/authentik-setup-plan";
import { call, type AuthentikFailure, type CoreApi, type User } from "./client";
import { guardUserWrite, type UserRefusal } from "./guard";
import { endSessionsOf } from "./sessions";

// Learner identities in Authentik (spec 0003 API surface). Every write goes
// through guardUserWrite first, which re-reads the target from Authentik.

export type LearnerRef = {
  readonly pk: number;
  readonly created: boolean; // this call created the Authentik user
  readonly tagged: boolean; // this call added the learner attributes
};

export type FindOrCreateError =
  | "is_admin"
  | "refused" // the Authentik account is inactive
  | "username_taken" // the lowercased email is another user's username
  | "duplicate_email" // two users have this email, differing only by case
  | "unavailable";

const learnerAttributes = (holUserId: string) => ({
  hol_learner: true,
  hol_user_id: holUserId,
});

async function usersBy(
  api: CoreApi,
  what: string,
  query: { readonly email?: string; readonly username?: string },
): Promise<Result<readonly User[], AuthentikFailure>> {
  const found = await call(`users.list by ${what}`, () =>
    api.coreUsersList({ ...query, pageSize: 20 }),
  );
  return found.ok ? ok(found.value.results) : found;
}

const sameEmail = (email: string) => (u: User) =>
  (u.email ?? "").toLowerCase() === email;

// Every candidate for this email: by the lowercased email and by the
// username (= lowercased email), deduplicated by pk.
async function candidates(
  api: CoreApi,
  email: string,
): Promise<Result<readonly User[], AuthentikFailure>> {
  const [byEmail, byUsername] = await Promise.all([
    usersBy(api, "email", { email }),
    usersBy(api, "username", { username: email }),
  ]);
  if (!byEmail.ok) return byEmail;
  if (!byUsername.ok) return byUsername;
  const all = [...byEmail.value, ...byUsername.value];
  return ok(all.filter((u, i) => all.findIndex((v) => v.pk === u.pk) === i));
}

// AC-5: one Authentik user per email, compared ignoring case. A known non
// admin user is reused; the only change is adding the learner attributes it
// lacks (never its type or path). A new user is `external` (AC-18) with no
// password: the welcome job sends the set password link.
export async function findOrCreateLearner(
  api: CoreApi,
  input: {
    readonly email: string;
    readonly name: string;
    readonly holUserId: string;
  },
): Promise<Result<LearnerRef, FindOrCreateError>> {
  const username = input.email.toLowerCase();
  const found = await candidates(api, username);
  if (!found.ok) return err("unavailable");

  const matches = found.value.filter(sameEmail(username));
  if (matches.length > 1) return err("duplicate_email");
  const [existing] = matches;
  if (existing) return reuseLearner(api, existing.pk, input.holUserId);
  if (found.value.some((u) => u.username.toLowerCase() === username))
    return err("username_taken");

  const created = await call("users.create", () =>
    api.coreUsersCreate({
      userRequest: {
        username,
        name: input.name,
        email: input.email,
        path: LEARNER_PATH,
        type: UserTypeEnum.External,
        isActive: true,
        attributes: learnerAttributes(input.holUserId),
      },
    }),
  );
  if (!created.ok) return err("unavailable");
  return ok({ pk: created.value.pk, created: true, tagged: false });
}

async function reuseLearner(
  api: CoreApi,
  pk: number,
  holUserId: string,
): Promise<Result<LearnerRef, FindOrCreateError>> {
  const guarded = await guardUserWrite(api, pk, "tag");
  if (!guarded.ok)
    return err(guarded.error === "is_admin" ? "is_admin" : "unavailable");
  const user = guarded.value;
  if (user.isActive === false) return err("refused");

  const attributes = user.attributes ?? {};
  const missing = Object.fromEntries(
    Object.entries(learnerAttributes(holUserId)).filter(
      ([key]) => !(key in attributes),
    ),
  );
  if (Object.keys(missing).length === 0)
    return ok({ pk, created: false, tagged: false });

  const patched = await call("users.tag", () =>
    api.coreUsersPartialUpdate({
      id: pk,
      patchedUserRequest: { attributes: { ...attributes, ...missing } },
    }),
  );
  if (!patched.ok) return err("unavailable");
  return ok({ pk, created: false, tagged: true });
}

// Compensation for a saga that created this user (spec 0002 AC-13).
export async function deleteSagaLearner(
  api: CoreApi,
  pk: number,
): Promise<Result<void, UserRefusal | AuthentikFailure>> {
  const guarded = await guardUserWrite(api, pk, "learner");
  if (!guarded.ok) return guarded;
  return call("users.destroy", () => api.coreUsersDestroy({ id: pk }));
}

// AC-6: requested when the welcome job sends, so a failure only retries the
// job. The link opens the brand's `hol-recovery` flow and lasts 72 hours,
// asked for on each call (Authentik's own default is 30 minutes).
// Guarded: a recovery link for an admin would be an account takeover.
export async function issueSetPasswordLink(
  api: CoreApi,
  pk: number,
): Promise<Result<string, UserRefusal | AuthentikFailure>> {
  const guarded = await guardUserWrite(api, pk, "learner");
  if (!guarded.ok) return guarded;
  const link = await call("users.recovery", () =>
    api.coreUsersRecoveryCreate({
      id: pk,
      userRecoveryLinkRequest: { tokenDuration: "hours=72" },
    }),
  );
  return link.ok ? ok(link.value.link) : link;
}

export type StatusChangeError = UserRefusal | AuthentikFailure;

type LearnerRow = {
  readonly id: string;
  readonly role: string;
  readonly authentik_user_pk: number | null;
  readonly auth_user_id: string | null;
};

async function learnerRow(
  conn: Kysely<DB>,
  usersId: string,
): Promise<Result<LearnerRow, StatusChangeError>> {
  const row = await conn
    .selectFrom("users")
    .select(["id", "role", "authentik_user_pk", "auth_user_id"])
    .where("id", "=", usersId)
    .executeTakeFirst();
  if (!row) return err("not_found");
  if (row.role !== "learner") return err("is_admin");
  return ok(row);
}

async function setActive(
  api: CoreApi,
  pk: number,
  isActive: boolean,
): Promise<Result<User, StatusChangeError>> {
  const guarded = await guardUserWrite(api, pk, "learner");
  if (!guarded.ok) return guarded;
  const patched = await call("users.set_active", () =>
    api.coreUsersPartialUpdate({ id: pk, patchedUserRequest: { isActive } }),
  );
  return patched.ok ? ok(guarded.value) : patched;
}

// AC-9: Authentik refuses their next sign in, their Authentik and app
// sessions end, and the row is marked deactivated. The guard refuses admins.
// Feature 10 adds the booking side effects and the access reconcile.
export async function deactivateLearner(
  api: CoreApi,
  conn: Kysely<DB>,
  usersId: string,
  actorId: string,
): Promise<Result<void, StatusChangeError>> {
  const row = await learnerRow(conn, usersId);
  if (!row.ok) return row;
  const pk = row.value.authentik_user_pk;
  if (pk !== null) {
    const user = await setActive(api, pk, false);
    if (!user.ok) return user;
    const ended = await endSessionsOf(api, user.value);
    if (!ended.ok) return ended;
  }

  await conn.transaction().execute(async (trx) => {
    await trx
      .updateTable("users")
      .set({ status: "deactivated", deactivated_at: sql`now()` })
      .where("id", "=", usersId)
      .where("status", "=", "active")
      .execute();
    if (row.value.auth_user_id !== null)
      await trx
        .deleteFrom("hol_auth.session")
        .where("userId", "=", row.value.auth_user_id)
        .execute();
    await audit(trx, {
      actorUserId: actorId,
      action: "user.deactivated",
      targetType: "user",
      targetId: usersId,
      summary: "Learner deactivated",
    });
  });
  return ok(undefined);
}

// AC-9: the reverse. The learner signs in again with their own password.
export async function reactivateLearner(
  api: CoreApi,
  conn: Kysely<DB>,
  usersId: string,
  actorId: string,
): Promise<Result<void, StatusChangeError>> {
  const row = await learnerRow(conn, usersId);
  if (!row.ok) return row;
  const pk = row.value.authentik_user_pk;
  if (pk !== null) {
    const user = await setActive(api, pk, true);
    if (!user.ok) return user;
  }

  await conn.transaction().execute(async (trx) => {
    await trx
      .updateTable("users")
      .set({ status: "active", deactivated_at: null })
      .where("id", "=", usersId)
      .where("status", "=", "deactivated")
      .execute();
    await audit(trx, {
      actorUserId: actorId,
      action: "user.reactivated",
      targetType: "user",
      targetId: usersId,
      summary: "Learner reactivated",
    });
  });
  return ok(undefined);
}
