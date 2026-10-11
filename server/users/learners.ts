import "server-only";
import { sql, type Kysely } from "kysely";
import { bookingPhase, type BookingPhase } from "@/lib/booking-phase";
import { BookingStatus, CancelSource, UserStatus } from "@/lib/db-enums";
import type { LearnerInput } from "@/lib/learner-input";
import { err, ok, type Result } from "@/lib/result";
import { audit } from "@/server/audit";
import type { CoreApi } from "@/server/authentik/client";
import {
  deleteSagaLearner,
  findOrCreateLearner,
  type FindOrCreateError,
} from "@/server/authentik/learners";
import { dbNow } from "@/server/db/bookings";
import { mapConstraintError } from "@/server/db/constraint-errors";
import { HAS_NO_BOOKINGS } from "@/server/db/guest-saga";
import type { DB } from "@/server/db/types";
import { enqueueWelcome, welcomeKey } from "@/server/jobs/send-welcome";

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
