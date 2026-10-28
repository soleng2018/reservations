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
  // The testbed create undo or its sweeper removed a group it created, or
  // the worker tore down a deleted testbed's group (spec 0007 AC-7).
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
  // Spec 0021 AC-7: a cleanup hook job failed for good (system actor).
  "cleanup_hook.failed",
  // Feature 9 (spec 0007). Never with a client's OS username or password.
  "testbed.updated",
  "testbed.deleted",
  // Feature 10 (spec 0008 AC-13).
  "user.created",
  "user.updated",
  // One row per booking, for an admin cancel and for deactivation.
  "booking.cancelled",
  // Feature 13 (spec 0011 AC-17): a learner moved their own booking.
  "booking.rescheduled",
  // The admin's own row, the first time the console learns their zone.
  "admin.timezone_set",
  // Feature 19 (spec 0017). The groups are predefined, so the app never
  // creates or deletes one: the worker releases a deleted testbed's group
  // (AC-9), and the reconciler found a recreated group again by name (AC-10).
  "authentik_group.released",
  "testbed.group_relinked",
  // Feature 20 (spec 0019). A learner's Nile login was set or first stored,
  // or a stored one was found taken in Authentik by another user.
  "user.nile_login_set",
  "user.nile_login_conflict",
  // Feature 25 (spec 0022). `seeded` is the migrate process (system actor).
  // The email address itself is never in an audit row, only that it changed.
  "portal_reset.seeded",
  "portal_reset.saved",
  "portal_reset.step_added",
  "portal_reset.step_updated",
  "portal_reset.step_removed",
  "portal_reset.steps_reordered",
  "portal_reset.email_changed",
  "portal_reset.mode_changed",
  // Feature 24 (spec 0023). All system actor, target a portal_reset_run.
  "portal_reset.run_finished",
  "portal_reset.run_aborted",
  "portal_reset.sign_in_failed",
  "portal_reset.guard_stop",
  "portal_reset.route_found",
  "portal_reset.report_failed",
  "portal_reset.credential_failed",
  "portal_reset.automation_user_created",
]);
export type AuditAction = z.infer<typeof AuditAction>;
