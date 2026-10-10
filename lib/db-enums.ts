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

export const ApiKeyType = z.enum(["IDP", "AI"]);
export type ApiKeyType = z.infer<typeof ApiKeyType>;

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
]);
export type JobKind = z.infer<typeof JobKind>;

export const JobStatus = z.enum(["pending", "running", "done", "failed"]);
export type JobStatus = z.infer<typeof JobStatus>;

export const AuditTargetType = z.enum([
  "testbed_type",
  "testbed",
  "api_key",
  "user",
  "booking",
  "authentik_group",
]);
export type AuditTargetType = z.infer<typeof AuditTargetType>;

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
  "bookings.status": BookingStatus.options,
  "bookings.cancel_source": CancelSource.options,
  "jobs.kind": JobKind.options,
  "jobs.status": JobStatus.options,
  "audit_events.target_type": AuditTargetType.options,
};
