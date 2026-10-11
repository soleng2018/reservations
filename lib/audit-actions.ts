import { z } from "zod";

// Dotted audit action names (spec 0002: a Zod union, no DB CHECK, so a new
// action needs no migration). Feature 4's actions per spec 0003 AC-16.
export const AuditAction = z.enum([
  "admin.signed_in",
  "admin.sign_in_refused",
  "user.created_in_authentik",
  "user.tagged_in_authentik",
  "user.deactivated",
  "user.reactivated",
  "set_password.resent",
  "booking.refused_admin_email",
  // AC-5: the lowercased email is another Authentik user's username.
  "booking.refused_username_taken",
  // AC-5: two Authentik users have this email, differing only by case.
  "booking.refused_duplicate_email",
  // Feature 6 (spec 0004).
  "testbed_type.created",
  "testbed.created",
  "authentik_group.created",
  // The testbed create undo or its sweeper removed a group it created.
  "authentik_group.deleted",
  "booking.created",
  // The reconciler added or removed a learner in a pod group.
  "access.granted",
  "access.revoked",
  // Feature 7.
  "testbed_type.updated",
  "testbed_type.deleted",
  // Feature 8 (spec 0006). Never with the secret or its ciphertext.
  "api_key.created",
  "api_key.updated",
  "api_key.secret_replaced",
  "api_key.deleted",
]);
export type AuditAction = z.infer<typeof AuditAction>;
