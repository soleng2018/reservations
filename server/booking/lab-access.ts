import "server-only";
import type { Kysely } from "kysely";
import { z } from "zod";
import { TestbedClientKind } from "@/lib/db-enums";
import type { LabAccessDetail, LabLinks } from "@/lib/lab-access";
import type { DB } from "@/server/db/types";

// The only read that returns lab links to a learner (spec 0012 AC-1). Every
// miss is `missing`, so another learner's booking looks like an unknown id.
// Columns are named one by one: client OS logins never leave this module.

export type OwnLabAccess =
  | { readonly kind: "ok"; readonly access: LabAccessDetail }
  | { readonly kind: "missing" };

const MISSING: OwnLabAccess = { kind: "missing" };
const LabStatus = z.enum(["confirmed", "completed"]);
const isId = (id: string) => z.uuid().safeParse(id).success;

export async function ownLabAccess(
  conn: Kysely<DB>,
  userId: string,
  bookingId: string,
): Promise<OwnLabAccess> {
  if (!isId(bookingId) || !isId(userId)) return MISSING;
  const row = await conn
    .selectFrom("bookings as b")
    .innerJoin("users as u", "u.id", "b.user_id")
    .innerJoin("testbeds as t", "t.id", "b.testbed_id")
    .innerJoin("testbed_types as ty", "ty.id", "b.testbed_type_id")
    .select([
      "b.status",
      "b.starts_at",
      "b.ends_at",
      "b.testbed_id",
      "t.name as testbedName",
      "t.portal_url",
      "t.lms_url",
      "ty.name as typeName",
    ])
    .where("b.id", "=", bookingId)
    .where("b.user_id", "=", userId)
    .where("b.status", "in", LabStatus.options)
    .where("u.role", "=", "learner")
    .where("u.status", "=", "active")
    .where("u.email_verified_at", "is not", null)
    .executeTakeFirst();
  if (!row) return MISSING;

  const clients = await conn
    .selectFrom("testbed_clients")
    .select(["name", "kind", "url"])
    .where("testbed_id", "=", row.testbed_id)
    .orderBy("position")
    .execute();

  return {
    kind: "ok",
    access: {
      testbedName: row.testbedName,
      typeName: row.typeName,
      status: LabStatus.parse(row.status),
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      links: {
        portalUrl: row.portal_url,
        lmsUrl: row.lms_url,
        clients: clients.map((c) => ({
          name: c.name,
          kind: TestbedClientKind.parse(c.kind),
          url: c.url,
        })),
      },
    },
  };
}

// The links for a success screen, read after its write committed (AC-2,
// AC-5). Best effort: a miss or a failed read leaves the card out, and the
// reply still reports the booking.
export async function ownLabLinks(
  conn: Kysely<DB>,
  userId: string,
  bookingId: string,
): Promise<LabLinks | null> {
  try {
    const found = await ownLabAccess(conn, userId, bookingId);
    return found.kind === "ok" ? found.access.links : null;
  } catch (e) {
    console.error(`lab access read failed for booking ${bookingId}`, e);
    return null;
  }
}

// AC-2, AC-3: links only when the session's own learner is the one booked.
// Identity comes from the session, never the post, so a guest (no session)
// gets none even when the email belongs to a verified learner.
export async function sessionLabLinks(
  conn: Kysely<DB>,
  sessionUserId: string | undefined,
  booked: { readonly userId: string; readonly bookingId: string },
): Promise<LabLinks | null> {
  if (sessionUserId === undefined || sessionUserId !== booked.userId)
    return null;
  return ownLabLinks(conn, sessionUserId, booked.bookingId);
}
