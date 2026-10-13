import "server-only";
import { sql, type Kysely } from "kysely";
import type { DetailsErrorCode } from "@/lib/booking-input";
import { err, ok, type Result } from "@/lib/result";
import { bookableTestbedsOfType } from "@/server/db/bookings";
import { STALE_OWN_ATTEMPT } from "@/server/db/guest-saga";
import type { DB } from "@/server/db/types";

// The /book Step 1 check (spec 0010 AC-2, step 4): read only, first match
// wins. It tells a guest early what the saga would refuse at confirm; the
// saga still decides under its locks.

export type DetailsRefusal = Exclude<
  DetailsErrorCode,
  "invalid" | "limited" | "signed_out"
>;

export async function checkGuestDetails(
  conn: Kysely<DB>,
  input: { readonly email: string; readonly testbedTypeId: string },
): Promise<Result<void, DetailsRefusal>> {
  const user = await conn
    .selectFrom("users")
    .select(["id", "role", "status"])
    .where(sql<string>`lower(email)`, "=", input.email.toLowerCase())
    .executeTakeFirst();

  if (user) {
    if (user.role === "admin") return err("admin_email");
    if (user.status !== "active") return err("refused");

    const live = await conn
      .selectFrom("bookings")
      .select("id")
      .where("user_id", "=", user.id)
      .where("status", "=", "confirmed")
      .where("ends_at", ">", sql<Date>`now()`)
      .executeTakeFirst();
    if (live) return err("has_live_booking");

    // An older attempt is ignored: the saga replaces it.
    const pending = await conn
      .selectFrom("bookings")
      .select("id")
      .where("user_id", "=", user.id)
      .where("status", "=", "provisioning")
      .where("created_at", ">=", STALE_OWN_ATTEMPT)
      .executeTakeFirst();
    if (pending) return err("booking_pending");
  }

  const type = await conn
    .selectFrom("testbed_types")
    .select("id")
    .where("id", "=", input.testbedTypeId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!type) return err("type_unavailable");
  const testbeds = await bookableTestbedsOfType(conn, input.testbedTypeId);
  if (testbeds.length === 0) return err("type_unavailable");

  return ok(undefined);
}
