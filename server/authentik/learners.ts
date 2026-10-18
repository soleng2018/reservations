import "server-only";
import { UserTypeEnum } from "@goauthentik/api/dist/esm/index.js";
import { sql, type Kysely } from "kysely";
import { bookingPhase } from "@/lib/booking-phase";
import { err, ok, type Result } from "@/lib/result";
import { audit } from "@/server/audit";
import { cancelBooking, dbNow } from "@/server/db/bookings";
import { Refusal, refusable } from "@/server/db/refusal";
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
  // Created, or reused but never signed in (spec 0008 AC-4): the account has
  // no password yet, so it needs the set password email.
  readonly neverLoggedIn: boolean;
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
  return ok({
    pk: created.value.pk,
    created: true,
    tagged: false,
    neverLoggedIn: true,
  });
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

  const neverLoggedIn = user.lastLogin == null;
  const attributes = user.attributes ?? {};
  const missing = Object.fromEntries(
    Object.entries(learnerAttributes(holUserId)).filter(
      ([key]) => !(key in attributes),
    ),
  );
  if (Object.keys(missing).length === 0)
    return ok({ pk, created: false, tagged: false, neverLoggedIn });

  const patched = await call("users.tag", () =>
    api.coreUsersPartialUpdate({
      id: pk,
      patchedUserRequest: { attributes: { ...attributes, ...missing } },
    }),
  );
  if (!patched.ok) return err("unavailable");
  return ok({ pk, created: false, tagged: true, neverLoggedIn });
}

// Spec 0008 AC-6: an admin's name or email fix. A new email also becomes the
// username (lowercased, the AC-5 rule), so it must not be another user's
// email or username first; this user's own pk never counts, so a case only
// change, or a save repeated after a failed commit, goes through.
export async function updateLearnerIdentity(
  api: CoreApi,
  pk: number,
  change: { readonly name?: string; readonly email?: string },
): Promise<Result<void, UserRefusal | AuthentikFailure | "taken">> {
  if (change.email !== undefined) {
    const found = await candidates(api, change.email.toLowerCase());
    if (!found.ok) return found;
    if (found.value.some((u) => u.pk !== pk)) return err("taken");
  }
  const guarded = await guardUserWrite(api, pk, "learner");
  if (!guarded.ok) return guarded;
  return call("users.update_identity", () =>
    api.coreUsersPartialUpdate({
      id: pk,
      patchedUserRequest: {
        ...(change.name !== undefined ? { name: change.name } : {}),
        ...(change.email !== undefined
          ? { email: change.email, username: change.email.toLowerCase() }
          : {}),
      },
    }),
  ).then((r) => (r.ok ? ok(undefined) : r));
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

// Spec 0003 AC-6 (amended by spec 0014): requested when the learner clicks
// the app's own link, for `tokenDuration` ("minutes=10"), and never stored.
// The link opens the brand's `hol-recovery` flow; Authentik keeps one token
// per user, so a second request returns the same link with the later expiry.
// Guarded: a recovery link for an admin would be an account takeover.
export async function issueSetPasswordLink(
  api: CoreApi,
  pk: number,
  tokenDuration: string,
): Promise<Result<string, UserRefusal | AuthentikFailure>> {
  const guarded = await guardUserWrite(api, pk, "learner");
  if (!guarded.ok) return guarded;
  const link = await call("users.recovery", () =>
    api.coreUsersRecoveryCreate({
      id: pk,
      userRecoveryLinkRequest: { tokenDuration },
    }),
  );
  return link.ok ? ok(link.value.link) : link;
}

export type StatusChangeError = UserRefusal | AuthentikFailure;

// The user row, locked FOR UPDATE (spec 0008 lock first pattern): a guest
// saga or a first sign in for this learner waits until the change commits.
async function lockLearnerRow(trx: Kysely<DB>, usersId: string) {
  const row = await trx
    .selectFrom("users")
    .select(["id", "role", "status", "authentik_user_pk", "auth_user_id"])
    .where("id", "=", usersId)
    .forUpdate()
    .executeTakeFirst();
  if (!row) throw new Refusal("not_found");
  if (row.role !== "learner") throw new Refusal("is_admin");
  return row;
}

// A row with no Authentik pk is still being added (or booked); the console
// never shows or changes it (spec 0008 key invariants), so it is not found.
function linkedPk(row: { readonly authentik_user_pk: number | null }) {
  if (row.authentik_user_pk === null) throw new Refusal("not_found");
  return row.authentik_user_pk;
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

// Spec 0003 AC-9, spec 0008 AC-8: Authentik refuses their next sign in,
// their Authentik and app sessions end, every Upcoming and Current booking is
// cancelled (`deactivation`, by the admin), and the row is marked
// deactivated, all under the user row lock. The access reconciler then
// removes them from testbed groups on its next tick. An Authentik account
// that no longer exists cannot sign in, so its not_found only warns. An
// already deactivated learner is a no op with no audit row.
export async function deactivateLearner(
  api: CoreApi,
  conn: Kysely<DB>,
  usersId: string,
  actorId: string,
): Promise<
  Result<{ readonly cancelled: number }, StatusChangeError | "booking_pending">
> {
  return refusable(() =>
    conn.transaction().execute(async (trx) => {
      const row = await lockLearnerRow(trx, usersId);
      const pk = linkedPk(row);
      if (row.status === "deactivated") return { cancelled: 0 };

      const pending = await trx
        .selectFrom("bookings")
        .select("id")
        .where("user_id", "=", usersId)
        .where("status", "=", "provisioning")
        .executeTakeFirst();
      if (pending) throw new Refusal("booking_pending");

      const user = await setActive(api, pk, false);
      if (!user.ok && user.error !== "not_found") throw new Refusal(user.error);
      if (!user.ok) console.warn(`deactivate: Authentik user ${pk} is gone`);
      else {
        const ended = await endSessionsOf(api, user.value);
        if (!ended.ok) throw new Refusal(ended.error);
      }

      await trx
        .updateTable("users")
        .set({ status: "deactivated", deactivated_at: sql`now()` })
        .where("id", "=", usersId)
        .execute();
      const cancelled = await cancelLiveBookings(trx, usersId, actorId);
      if (row.auth_user_id !== null)
        await trx
          .deleteFrom("hol_auth.session")
          .where("userId", "=", row.auth_user_id)
          .execute();
      await audit(trx, {
        actorUserId: actorId,
        action: "user.deactivated",
        targetType: "user",
        targetId: usersId,
        summary: "Learner deactivated",
        metadata: { cancelledBookings: cancelled },
      });
      return { cancelled };
    }),
  );
}

// Every confirmed booking that has not ended, each version read under its
// row lock, cancelled by the deactivating admin with one audit row each.
async function cancelLiveBookings(
  trx: Kysely<DB>,
  usersId: string,
  actorId: string,
): Promise<number> {
  const live = await trx
    .selectFrom("bookings")
    .select(["id", "version", "testbed_id", "starts_at", "ends_at"])
    .where("user_id", "=", usersId)
    .where("status", "=", "confirmed")
    .where("ends_at", ">", sql<Date>`now()`)
    .orderBy("starts_at")
    .forUpdate()
    .execute();
  const now = await dbNow(trx);
  return live.reduce<Promise<number>>(async (count, b) => {
    const n = await count;
    const done = await cancelBooking(trx, {
      id: b.id,
      expectedVersion: b.version,
      source: "deactivation",
      byUserId: actorId,
    });
    if (!done.ok) return n;
    await audit(trx, {
      actorUserId: actorId,
      action: "booking.cancelled",
      targetType: "booking",
      targetId: b.id,
      summary: "Reservation cancelled",
      metadata: {
        source: "deactivation",
        userId: usersId,
        testbedId: b.testbed_id,
        phase: bookingPhase(
          { status: "confirmed", startsAt: b.starts_at, endsAt: b.ends_at },
          now,
        ),
      },
    });
    return n + 1;
  }, Promise.resolve(0));
}

// Spec 0003 AC-9, spec 0008 AC-9: the reverse, under the user row lock. The
// learner signs in again with their own password; cancelled bookings stay
// cancelled. An active learner is a no op with no audit row.
export async function reactivateLearner(
  api: CoreApi,
  conn: Kysely<DB>,
  usersId: string,
  actorId: string,
): Promise<Result<void, StatusChangeError>> {
  return refusable(() =>
    conn.transaction().execute(async (trx) => {
      const row = await lockLearnerRow(trx, usersId);
      const pk = linkedPk(row);
      if (row.status === "active") return;
      const user = await setActive(api, pk, true);
      if (!user.ok) throw new Refusal(user.error);
      await trx
        .updateTable("users")
        .set({ status: "active", deactivated_at: null })
        .where("id", "=", usersId)
        .execute();
      await audit(trx, {
        actorUserId: actorId,
        action: "user.reactivated",
        targetType: "user",
        targetId: usersId,
        summary: "Learner reactivated",
      });
    }),
  );
}
