import "server-only";
import { sql, type Kysely } from "kysely";
import { bookingPhase, type BookingPhase } from "@/lib/booking-phase";
import { changedFields } from "@/lib/changed-fields";
import type { Blocker } from "@/lib/delete-flow";
import { formatDateTime } from "@/lib/format-time";
import { BookingStatus, CancelSource, UserStatus } from "@/lib/db-enums";
import type { LearnerInput } from "@/lib/learner-input";
import { err, ok, type Result } from "@/lib/result";
import { audit } from "@/server/audit";
import type { AuthentikFailure, CoreApi } from "@/server/authentik/client";
import type { UserRefusal } from "@/server/authentik/guard";
import {
  deleteSagaLearner,
  findOrCreateLearner,
  updateLearnerIdentity,
  type FindOrCreateError,
} from "@/server/authentik/learners";
import { cancelBooking, dbNow } from "@/server/db/bookings";
import { mapConstraintError } from "@/server/db/constraint-errors";
import { HAS_NO_BOOKINGS } from "@/server/db/guest-saga";
import { Refusal, refusable } from "@/server/db/refusal";
import type { DB } from "@/server/db/types";
import {
  enqueueWelcome,
  resendKey,
  welcomeKey,
} from "@/server/jobs/send-welcome";

// Learner admin (spec 0008): the users list, the user detail page, and the
// learner changes an admin makes from the console. Only learners with an
// Authentik pk are ever shown or changed; a row still being added or booked
// (pk null) is hidden.

export type AdminLearnerRow = {
  readonly id: string;
  readonly name: string;
  readonly company: string | null;
  readonly email: string;
  readonly timezone: string;
  readonly status: UserStatus;
  readonly reservationCount: number;
  readonly emailEditable: boolean;
};

// AC-1. The count is the detail page's Upcoming, Current, and Past rows: every
// booking except cancelled and provisioning.
export async function listLearnersForAdmin(
  conn: Kysely<DB>,
): Promise<readonly AdminLearnerRow[]> {
  const rows = await conn
    .selectFrom("users as u")
    .select((eb) => [
      "u.id",
      "u.name",
      "u.company",
      "u.email",
      "u.timezone",
      "u.status",
      "u.set_password_pending",
      eb
        .selectFrom("bookings as b")
        .select(sql<number>`count(*)::int`.as("n"))
        .whereRef("b.user_id", "=", "u.id")
        .where("b.status", "in", ["confirmed", "completed"])
        .as("reservationCount"),
    ])
    .where("u.role", "=", "learner")
    .where("u.authentik_user_pk", "is not", null)
    .orderBy(sql`lower(u.name)`)
    .orderBy("u.id")
    .execute();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    company: r.company,
    email: r.email,
    timezone: r.timezone,
    status: UserStatus.parse(r.status),
    reservationCount: r.reservationCount ?? 0,
    emailEditable: r.set_password_pending,
  }));
}

export type LearnerBooking = {
  readonly id: string;
  readonly version: number;
  readonly phase: BookingPhase;
  readonly cancelSource: CancelSource | null;
  readonly testbedName: string;
  readonly typeName: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
};

export type LearnerDetail = {
  readonly learner: AdminLearnerRow & {
    readonly setPasswordPending: boolean;
  };
  readonly bookings: readonly LearnerBooking[];
};

// AC-2. Testbed and type names show even when soft deleted; phases use the
// DB clock. Reads only (no completeEndedForUser here).
export async function getLearnerDetail(
  conn: Kysely<DB>,
  id: string,
): Promise<Result<LearnerDetail, "not_found">> {
  const user = await conn
    .selectFrom("users")
    .select([
      "id",
      "name",
      "company",
      "email",
      "timezone",
      "status",
      "set_password_pending",
    ])
    .where("id", "=", id)
    .where("role", "=", "learner")
    .where("authentik_user_pk", "is not", null)
    .executeTakeFirst();
  if (!user) return err("not_found");

  const [rows, now] = await Promise.all([
    conn
      .selectFrom("bookings as b")
      .innerJoin("testbeds as t", "t.id", "b.testbed_id")
      .innerJoin("testbed_types as ty", "ty.id", "b.testbed_type_id")
      .select([
        "b.id",
        "b.version",
        "b.status",
        "b.cancel_source",
        "b.starts_at",
        "b.ends_at",
        "t.name as testbedName",
        "ty.name as typeName",
      ])
      .where("b.user_id", "=", id)
      .orderBy("b.starts_at", "desc")
      .orderBy("b.id")
      .execute(),
    dbNow(conn),
  ]);

  const bookings = rows.map((b) => {
    const status = BookingStatus.parse(b.status);
    return {
      id: b.id,
      version: b.version,
      phase: bookingPhase(
        { status, startsAt: b.starts_at, endsAt: b.ends_at },
        now,
      ),
      cancelSource:
        b.cancel_source === null ? null : CancelSource.parse(b.cancel_source),
      testbedName: b.testbedName,
      typeName: b.typeName,
      startsAt: b.starts_at,
      endsAt: b.ends_at,
    };
  });
  const status = UserStatus.parse(user.status);
  return ok({
    learner: {
      id: user.id,
      name: user.name,
      company: user.company,
      email: user.email,
      timezone: user.timezone,
      status,
      reservationCount: bookings.filter(
        (b) => b.phase !== "Cancelled" && b.phase !== "Pending",
      ).length,
      emailEditable: user.set_password_pending,
      setPasswordPending: user.set_password_pending,
    },
    bookings,
  });
}

// The add saga (spec 0008 *State transitions*, AC-4, AC-5): insert the row
// with no pk and commit; find or create the Authentik user stamped with that
// row id; then store the pk, raise the pending flag and queue the welcome
// job when the account has no password yet, and audit, in one transaction.
// Every cleanup delete rechecks "no pk, no bookings" in the statement, so a
// row a guest booking picked up meanwhile is kept with its Authentik user.

export type CreateLearnerError =
  | { readonly kind: "duplicate"; readonly id: string }
  | "setting_up" // the email's row has no pk yet: another add or a booking
  | "admin_email"
  | "authentik_conflict" // username_taken or duplicate_email in Authentik
  | "authentik_disabled"
  | "unavailable";

class InvariantBroken extends Error {}

// Why an email already in `users` can't be added again.
async function existingEmail(
  conn: Kysely<DB>,
  email: string,
): Promise<CreateLearnerError | undefined> {
  const row = await conn
    .selectFrom("users")
    .select(["id", "role", "authentik_user_pk"])
    .where(sql<string>`lower(email)`, "=", email.toLowerCase())
    .executeTakeFirst();
  if (!row) return undefined;
  if (row.role === "admin") return "admin_email";
  if (row.authentik_user_pk === null) return "setting_up";
  return { kind: "duplicate", id: row.id };
}

async function insertLearnerRow(
  conn: Kysely<DB>,
  input: LearnerInput,
): Promise<Result<string, CreateLearnerError>> {
  try {
    const inserted = await conn.transaction().execute(async (trx) => {
      const existing = await existingEmail(trx, input.email);
      if (existing) return err(existing);
      const row = await trx
        .insertInto("users")
        .values({
          role: "learner",
          name: input.name,
          company: input.company,
          email: input.email,
          timezone: input.timezone,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      return ok(row.id);
    });
    return inserted;
  } catch (e) {
    // Two admins adding the same email at once.
    const mapped = mapConstraintError(e);
    if (mapped.ok || mapped.error !== "duplicate_email") throw e;
    return err((await existingEmail(conn, input.email)) ?? "setting_up");
  }
}

// Deletes the saga's row only while it still has no pk and no bookings.
async function deleteUnlinkedRow(
  conn: Kysely<DB>,
  id: string,
): Promise<boolean> {
  const gone = await conn
    .deleteFrom("users")
    .where("id", "=", id)
    .where("role", "=", "learner")
    .where("authentik_user_pk", "is", null)
    .where(HAS_NO_BOOKINGS)
    .executeTakeFirst();
  return Number(gone.numDeletedRows) > 0;
}

const addRefusal = (e: FindOrCreateError): CreateLearnerError => {
  switch (e) {
    case "is_admin":
      return "admin_email";
    case "refused":
      return "authentik_disabled";
    case "username_taken":
    case "duplicate_email":
      return "authentik_conflict";
    case "unavailable":
      return "unavailable";
    default: {
      const never: never = e;
      return never;
    }
  }
};

export async function createLearner(
  api: CoreApi,
  conn: Kysely<DB>,
  input: LearnerInput,
  actorId: string,
): Promise<Result<{ readonly id: string }, CreateLearnerError>> {
  const inserted = await insertLearnerRow(conn, input);
  if (!inserted.ok) return inserted;
  const id = inserted.value;

  const learner = await findOrCreateLearner(api, {
    email: input.email,
    name: input.name,
    holUserId: id,
  }).catch(async (e: unknown) => {
    await deleteUnlinkedRow(conn, id);
    throw e;
  });
  if (!learner.ok) {
    await deleteUnlinkedRow(conn, id);
    return err(addRefusal(learner.error));
  }
  const { pk, created, tagged, neverLoggedIn } = learner.value;

  try {
    await conn.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom("users")
        .select("authentik_user_pk")
        .where("id", "=", id)
        .forUpdate()
        .executeTakeFirst();
      if (!row) throw new Error(`learner ${id} vanished before its pk`);
      // A guest saga for the same email may have stored the same pk first.
      if (row.authentik_user_pk !== null && row.authentik_user_pk !== pk)
        throw new InvariantBroken(
          `learner ${id} holds Authentik user ${row.authentik_user_pk}, not ${pk}`,
        );
      await trx
        .updateTable("users")
        .set({
          authentik_user_pk: pk,
          ...(neverLoggedIn ? { set_password_pending: true } : {}),
        })
        .where("id", "=", id)
        .execute();
      if (neverLoggedIn) await enqueueWelcome(trx, id, welcomeKey(id));
      await audit(trx, {
        actorUserId: actorId,
        action: "user.created",
        targetType: "user",
        targetId: id,
        summary: "Learner added",
        metadata: { reusedAuthentikUser: !created },
      });
      if (created || tagged)
        await audit(trx, {
          actorUserId: actorId,
          action: created
            ? "user.created_in_authentik"
            : "user.tagged_in_authentik",
          targetType: "user",
          targetId: id,
          summary: created
            ? "Learner created in Authentik"
            : "Existing Authentik user tagged as a learner",
          metadata: { authentikUserPk: pk },
        });
    });
  } catch (e) {
    const deleted = await deleteUnlinkedRow(conn, id);
    if (deleted && created) {
      const undone = await deleteSagaLearner(api, pk);
      if (!undone.ok)
        console.error(`add learner: could not delete Authentik ${pk}`);
    }
    if (e instanceof InvariantBroken) throw e;
    console.error("add learner: final step failed", e);
    return err("unavailable");
  }
  return ok({ id });
}

// The lock first pattern (spec 0008 *State transitions*): one transaction
// locks the learner row, checks every precondition against it, calls
// Authentik while holding the lock, then writes the app side. A Refusal
// rolls it all back.

// The learner row, locked FOR UPDATE: a learner with an Authentik pk, or a
// "not_found" refusal (an admin row is never changed here).
async function lockLearner(trx: Kysely<DB>, id: string) {
  const row = await trx
    .selectFrom("users")
    .select([
      "id",
      "role",
      "status",
      "name",
      "company",
      "email",
      "timezone",
      "set_password_pending",
      "authentik_user_pk",
      "auth_user_id",
    ])
    .where("id", "=", id)
    .forUpdate()
    .executeTakeFirst();
  if (!row || row.role !== "learner" || row.authentik_user_pk === null)
    throw new Refusal("not_found");
  return { ...row, pk: row.authentik_user_pk };
}

export type UpdateLearnerError =
  | { readonly kind: "duplicate"; readonly id: string | null }
  | "authentik_conflict"
  | "email_locked"
  | "not_found"
  | "refused"
  | "unavailable";

const EDITED_FIELDS = ["name", "company", "email", "timezone"] as const;

// The duplicate error for an email another row holds; the link only for a
// learner the console can show.
async function duplicateOf(
  conn: Kysely<DB>,
  id: string,
  email: string,
): Promise<UpdateLearnerError | undefined> {
  const other = await conn
    .selectFrom("users")
    .select(["id", "role", "authentik_user_pk"])
    .where(sql<string>`lower(email)`, "=", email.toLowerCase())
    .where("id", "<>", id)
    .executeTakeFirst();
  if (!other) return undefined;
  const linkable = other.role === "learner" && other.authentik_user_pk !== null;
  return { kind: "duplicate", id: linkable ? other.id : null };
}

const identityRefusal = (
  e: UserRefusal | AuthentikFailure | "taken",
): UpdateLearnerError => {
  switch (e) {
    case "taken":
      return "authentik_conflict";
    case "is_admin":
    case "not_learner":
    // The Authentik account is gone: the owner has to look at it.
    case "not_found":
      return "refused";
    case "unavailable":
      return "unavailable";
    default: {
      const never: never = e;
      return never;
    }
  }
};

// AC-6. Name and email go to Authentik (a company or timezone only edit
// makes no call); the email changes only while the learner has never set a
// password. A save that changes nothing writes nothing.
export async function updateLearner(
  api: CoreApi,
  conn: Kysely<DB>,
  id: string,
  input: LearnerInput,
  actorId: string,
): Promise<Result<void, UpdateLearnerError>> {
  try {
    return await refusable<void, UpdateLearnerError>(() =>
      conn.transaction().execute(async (trx) => {
        const row = await lockLearner(trx, id);
        const emailChanged = input.email !== row.email;
        const nameChanged = input.name !== row.name;
        if (emailChanged) {
          if (!row.set_password_pending) throw new Refusal("email_locked");
          const duplicate = await duplicateOf(trx, id, input.email);
          if (duplicate) throw new Refusal(duplicate);
        }

        const changed = changedFields(EDITED_FIELDS, row, input);
        if (Object.keys(changed).length === 0) return;

        const synced = nameChanged || emailChanged;
        if (synced) {
          const pushed = await updateLearnerIdentity(api, row.pk, {
            name: input.name,
            ...(emailChanged ? { email: input.email } : {}),
          });
          if (!pushed.ok) throw new Refusal(identityRefusal(pushed.error));
        }

        await trx
          .updateTable("users")
          .set({
            name: input.name,
            company: input.company,
            email: input.email,
            timezone: input.timezone,
          })
          .where("id", "=", id)
          .execute();
        if (emailChanged)
          await enqueueWelcome(
            trx,
            id,
            `welcome:${id}:email:${input.email.toLowerCase()}`,
          );
        await audit(trx, {
          actorUserId: actorId,
          action: "user.updated",
          targetType: "user",
          targetId: id,
          summary: "Learner updated",
          metadata: synced ? { ...changed, authentikSynced: true } : changed,
        });
      }),
    );
  } catch (e) {
    // Two rows took the same email at once. Authentik may already hold it,
    // which a later save of the same values converges.
    const mapped = mapConstraintError(e);
    if (mapped.ok || mapped.error !== "duplicate_email") throw e;
    return err(
      (await duplicateOf(conn, id, input.email)) ?? {
        kind: "duplicate",
        id: null,
      },
    );
  }
}

// AC-7: the console's resend, one job per hour like the public one.
export async function resendSetPasswordByAdmin(
  conn: Kysely<DB>,
  id: string,
  actorId: string,
): Promise<Result<{ readonly email: string }, "not_eligible">> {
  return conn.transaction().execute(async (trx) => {
    const learner = await trx
      .selectFrom("users")
      .select(["id", "email"])
      .where("id", "=", id)
      .where("role", "=", "learner")
      .where("authentik_user_pk", "is not", null)
      .where("status", "=", "active")
      .where("set_password_pending", "=", true)
      .executeTakeFirst();
    if (!learner) return err("not_eligible");
    await enqueueWelcome(trx, id, resendKey(id, new Date()));
    await audit(trx, {
      actorUserId: actorId,
      action: "set_password.resent",
      targetType: "user",
      targetId: id,
      summary: "Set password email resent by an admin",
    });
    return ok({ email: learner.email });
  });
}

// AC-8: the bookings a deactivation would cancel (confirmed, not ended),
// oldest start first, labelled for the confirm dialog in the admin's zone.
export async function deactivationPreview(
  conn: Kysely<DB>,
  id: string,
  timezone: string,
): Promise<readonly Blocker[]> {
  const [rows, now] = await Promise.all([
    conn
      .selectFrom("bookings as b")
      .innerJoin("users as u", "u.id", "b.user_id")
      .innerJoin("testbeds as t", "t.id", "b.testbed_id")
      .select(["b.id", "b.starts_at", "b.ends_at", "t.name as testbedName"])
      .where("b.user_id", "=", id)
      .where("u.role", "=", "learner")
      .where("b.status", "=", "confirmed")
      .where("b.ends_at", ">", sql<Date>`now()`)
      .orderBy("b.starts_at")
      .orderBy("b.id")
      .execute(),
    dbNow(conn),
  ]);
  return rows.map((b) => {
    const phase = bookingPhase(
      { status: "confirmed", startsAt: b.starts_at, endsAt: b.ends_at },
      now,
    );
    return {
      id: b.id,
      label: `${b.testbedName} — ${phase} reservation, ${formatDateTime(b.starts_at, timezone)}`,
    };
  });
}

// Whether the console can show this learner (AC-1, AC-2): it tells a missing
// app row apart from a missing Authentik account after a refusal.
export async function isConsoleLearner(
  conn: Kysely<DB>,
  id: string,
): Promise<boolean> {
  const row = await conn
    .selectFrom("users")
    .select("id")
    .where("id", "=", id)
    .where("role", "=", "learner")
    .where("authentik_user_pk", "is not", null)
    .executeTakeFirst();
  return row !== undefined;
}

// AC-10: an admin cancels one Upcoming or Current booking, whoever's it is,
// at the version they saw. The phase it had is read under the same guard.
export async function cancelBookingByAdmin(
  conn: Kysely<DB>,
  bookingId: string,
  version: number,
  actorId: string,
): Promise<Result<void, "stale">> {
  return refusable<void, "stale">(() =>
    conn.transaction().execute(async (trx) => {
      const booking = await trx
        .selectFrom("bookings")
        .select(["user_id", "testbed_id", "starts_at", "ends_at"])
        .where("id", "=", bookingId)
        .where("status", "=", "confirmed")
        .where("ends_at", ">", sql<Date>`now()`)
        .where("version", "=", version)
        .forUpdate()
        .executeTakeFirst();
      if (!booking) throw new Refusal("stale");
      const cancelled = await cancelBooking(trx, {
        id: bookingId,
        expectedVersion: version,
        source: "admin",
        byUserId: actorId,
      });
      if (!cancelled.ok) throw new Refusal("stale");
      await audit(trx, {
        actorUserId: actorId,
        action: "booking.cancelled",
        targetType: "booking",
        targetId: bookingId,
        summary: "Reservation cancelled",
        metadata: {
          source: "admin",
          userId: booking.user_id,
          testbedId: booking.testbed_id,
          phase: bookingPhase(
            {
              status: "confirmed",
              startsAt: booking.starts_at,
              endsAt: booking.ends_at,
            },
            await dbNow(trx),
          ),
        },
      });
    }),
  );
}
