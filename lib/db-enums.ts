import { z } from "zod";

// Every CHECK (col in (...)) list in hol_app, as the Zod enum the app reads
// (kysely-codegen types these columns as plain `string`). db-enums.test.ts
// compares `checkLists` against the live constraints, so the two never drift.

export const UserRole = z.enum(["learner", "admin"]);
export type UserRole = z.infer<typeof UserRole>;

export const UserStatus = z.enum(["active", "deactivated"]);
export type UserStatus = z.infer<typeof UserStatus>;

export const DurationUnit = z.enum(["hours", "days"]);
export type DurationUnit = z.infer<typeof DurationUnit>;

export const TestbedClientKind = z.enum(["wired", "wireless"]);
export type TestbedClientKind = z.infer<typeof TestbedClientKind>;

export const ApiKeyType = z.enum([
  "IDP",
  "AI",
  "CLOUDFLARE",
  "GOOGLE",
  "CLEANUP",
]);
export type ApiKeyType = z.infer<typeof ApiKeyType>;

// Spec 0013 AC-25, AC-34: how a GOOGLE key signs in.
export const GoogleAuthMethod = z.enum(["service_account", "oauth"], {
  error: "Choose a sign in method.",
});
export type GoogleAuthMethod = z.infer<typeof GoogleAuthMethod>;

export const BookingStatus = z.enum([
  "provisioning",
  "confirmed",
  "cancelled",
  "completed",
]);
export type BookingStatus = z.infer<typeof BookingStatus>;

export const CancelSource = z.enum(["learner", "admin", "deactivation"]);
export type CancelSource = z.infer<typeof CancelSource>;

export const JobKind = z.enum([
  "send_email",
  "calendar_upsert",
  "calendar_delete",
  "send_welcome",
  "cleanup_notify",
  "send_reset_report",
]);
export type JobKind = z.infer<typeof JobKind>;

export const JobStatus = z.enum(["pending", "running", "done", "failed"]);
export type JobStatus = z.infer<typeof JobStatus>;

// Spec 0013: the email outbox.
export const EmailKind = z.enum([
  "welcome",
  "booked",
  "rescheduled",
  "cancelled",
  "reminder",
]);
export type EmailKind = z.infer<typeof EmailKind>;

export const EmailStatus = z.enum(["queued", "sent", "failed", "suppressed"]);
export type EmailStatus = z.infer<typeof EmailStatus>;

// Spec 0014: why a set password link stopped working before it expired.
export const SetPasswordLinkEndReason = z.enum([
  "used",
  "other_used",
  "email_changed",
]);
export type SetPasswordLinkEndReason = z.infer<typeof SetPasswordLinkEndReason>;

export const AuditTargetType = z.enum([
  "testbed_type",
  "testbed",
  "api_key",
  "user",
  "booking",
  "authentik_group",
  "portal_reset_step",
  "portal_reset_settings",
  "portal_reset_run",
]);
export type AuditTargetType = z.infer<typeof AuditTargetType>;

// Spec 0022 AC-22: whether a Nile Portal reset runs at all, runs read only, or
// deletes for real.
export const PortalResetMode = z.enum(["off", "dry_run", "live"]);
export type PortalResetMode = z.infer<typeof PortalResetMode>;

// Spec 0023: the reset engine's run records.
export const PortalResetEvent = z.enum(["lab_ended", "ended_early", "moved"]);
export type PortalResetEvent = z.infer<typeof PortalResetEvent>;

export const PortalResetRunMode = z.enum(["dry_run", "live"]);
export type PortalResetRunMode = z.infer<typeof PortalResetRunMode>;

export const PortalResetRunState = z.enum([
  "queued",
  "running",
  "held",
  "done",
  "incomplete",
  "aborted",
]);
export type PortalResetRunState = z.infer<typeof PortalResetRunState>;

export const PortalResetAbortReason = z.enum([
  "mode_off",
  "sign_in_failed",
  "tenant_mismatch",
  "guard_stop",
  "lab_started",
  "deadline",
  "testbed_unavailable",
  "invalid_list",
  "crashed",
]);
export type PortalResetAbortReason = z.infer<typeof PortalResetAbortReason>;

export const PortalResetSignInReason = z.enum([
  "credential_failed",
  "idp_rejected",
  "browser_unavailable",
  "portal_unreachable",
  "timeout",
  "token_missing",
]);
export type PortalResetSignInReason = z.infer<typeof PortalResetSignInReason>;

export const PortalResetItemKind = z.enum([
  "deleted",
  "changed",
  "failed",
  "would_delete",
  "would_change",
  "route_found",
]);
export type PortalResetItemKind = z.infer<typeof PortalResetItemKind>;

export const PortalResetItemMethod = z.enum(["GET", "POST", "PUT", "DELETE"]);
export type PortalResetItemMethod = z.infer<typeof PortalResetItemMethod>;

export const PortalResetReportNote = z.enum([
  "not_needed",
  "no_address",
  "queued",
]);
export type PortalResetReportNote = z.infer<typeof PortalResetReportNote>;

// Statuses that hold a testbed slot and count toward one live booking per user.
export const LIVE_BOOKING_STATUSES = [
  "provisioning",
  "confirmed",
] as const satisfies readonly BookingStatus[];

// "table.column" → enum, for the parity test. Add each new CHECK list here.
export const checkLists: Readonly<Record<string, readonly string[]>> = {
  "users.role": UserRole.options,
  "users.status": UserStatus.options,
  "testbed_types.duration_unit": DurationUnit.options,
  "testbed_clients.kind": TestbedClientKind.options,
  "api_keys.type": ApiKeyType.options,
  "api_keys.google_auth": GoogleAuthMethod.options,
  "bookings.status": BookingStatus.options,
  "bookings.cancel_source": CancelSource.options,
  "jobs.kind": JobKind.options,
  "jobs.status": JobStatus.options,
  "email_messages.kind": EmailKind.options,
  "email_messages.status": EmailStatus.options,
  "set_password_links.ended_reason": SetPasswordLinkEndReason.options,
  "audit_events.target_type": AuditTargetType.options,
  "portal_reset_settings.mode": PortalResetMode.options,
  "portal_reset_runs.event": PortalResetEvent.options,
  "portal_reset_runs.mode": PortalResetRunMode.options,
  "portal_reset_runs.state": PortalResetRunState.options,
  "portal_reset_runs.abort_reason": PortalResetAbortReason.options,
  "portal_reset_runs.sign_in_reason": PortalResetSignInReason.options,
  "portal_reset_runs.report_note": PortalResetReportNote.options,
  "portal_reset_run_items.kind": PortalResetItemKind.options,
  "portal_reset_run_items.method": PortalResetItemMethod.options,
};
