import "server-only";
import { sql, type Kysely } from "kysely";
import { bookingPhase, type BookingPhase } from "@/lib/booking-phase";
import { BookingStatus, CancelSource, UserStatus } from "@/lib/db-enums";
import { err, ok, type Result } from "@/lib/result";
import { dbNow } from "@/server/db/bookings";
import type { DB } from "@/server/db/types";

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
