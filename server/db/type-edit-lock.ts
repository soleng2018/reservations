import "server-only";
import { sql, type Kysely } from "kysely";
import type { DB } from "./types";

// Spec 0026 AC-19. A per type advisory lock, held to the end of the
// transaction. A rename, a delete, and the backfill of the same type take it
// first, so two of them never run their Authentik calls side by side. It is
// not a row lock, so a booking (which takes the type row FOR SHARE) is never
// held up by it.
export async function lockTypeEdit(
  trx: Kysely<DB>,
  typeId: string,
): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`testbed_type_edit:${typeId}`}, 0))`.execute(
    trx,
  );
}
