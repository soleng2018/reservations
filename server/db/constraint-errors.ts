import "server-only";
import { z } from "zod";
import { err, type Result } from "@/lib/result";

export type ConstraintError =
  | "overlap"
  | "user_has_live_booking"
  | "duplicate_name"
  | "duplicate_email"
  | "duplicate_slug"
  | "in_use";

// Constraint names are a contract with db/migrations: renaming one there is a
// breaking change here.
const byConstraint: Readonly<Record<string, ConstraintError>> = {
  bookings_no_overlap: "overlap",
  bookings_one_live_per_user: "user_has_live_booking",
  users_email_lower_uq: "duplicate_email",
  testbeds_slug_uq: "duplicate_slug",
  testbed_types_name_lower_uq: "duplicate_name",
  testbeds_name_lower_uq: "duplicate_name",
  api_keys_name_lower_uq: "duplicate_name",
};

const PgError = z.object({
  code: z.string(),
  constraint: z.string().optional(),
  detail: z.string().optional(),
});

// Turns an expected constraint violation into a typed error so Postgres text
// never reaches users. Anything else is a bug and is rethrown. Postgres aborts
// the transaction on any of these, so callers map outside the transaction.
export function mapConstraintError(e: unknown): Result<never, ConstraintError> {
  const parsed = PgError.safeParse(e);
  if (!parsed.success) throw e;
  const { code, constraint, detail } = parsed.data;

  switch (code) {
    case "23P01": // exclusion_violation
    case "23505": {
      // unique_violation
      const mapped = constraint ? byConstraint[constraint] : undefined;
      if (mapped) return err(mapped);
      break;
    }
    case "23503": // foreign_key_violation: only a RESTRICT on delete is expected
      if (detail?.includes("is still referenced")) return err("in_use");
      break;
  }
  throw e;
}
