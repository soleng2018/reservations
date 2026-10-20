import { z } from "zod";
import { AuditAction } from "@/lib/audit-actions";
import type { AuditTargetType, UserRole } from "@/lib/db-enums";

// Spec 0016: the pure half of the Audit Log. Labels, areas, and actor kinds
// are display mappings over what is stored, so they are right for old rows
// too and change no write path.

// AC-13: the areas an admin can filter by.
export const AuditArea = z.enum([
  "admin",
  "api_keys",
  "testbed_types",
  "testbeds",
  "access_groups",
  "users",
  "bookings",
]);
export type AuditArea = z.infer<typeof AuditArea>;

export const AUDIT_AREA_LABEL = {
  admin: "Admin",
  api_keys: "API keys",
  testbed_types: "Testbed types",
  testbeds: "Testbeds",
  access_groups: "Access groups",
  users: "Users",
  bookings: "Bookings",
} as const satisfies Record<AuditArea, string>;

export type AuditActionInfo = {
  readonly label: string;
  readonly area: AuditArea;
};

// AC-13: every action's label and area. `satisfies` makes a new
// AuditAction fail to compile until it is labelled here.
export const AUDIT_ACTION_INFO = {
  "admin.signed_in": { label: "Admin signed in", area: "admin" },
  "admin.sign_in_refused": { label: "Admin sign in refused", area: "admin" },
  "admin.timezone_set": { label: "Admin timezone set", area: "admin" },
  "api_key.created": { label: "API key created", area: "api_keys" },
  "api_key.updated": { label: "API key updated", area: "api_keys" },
  "api_key.secret_replaced": {
    label: "API key secret replaced",
    area: "api_keys",
  },
  "api_key.deleted": { label: "API key deleted", area: "api_keys" },
  "testbed_type.created": {
    label: "Testbed type created",
    area: "testbed_types",
  },
  "testbed_type.updated": {
    label: "Testbed type updated",
    area: "testbed_types",
  },
  "testbed_type.deleted": {
    label: "Testbed type deleted",
    area: "testbed_types",
  },
  "testbed.created": { label: "Testbed created", area: "testbeds" },
  "testbed.updated": { label: "Testbed updated", area: "testbeds" },
  "testbed.deleted": { label: "Testbed deleted", area: "testbeds" },
  "authentik_group.created": {
    label: "Authentik group created",
    area: "access_groups",
  },
  "authentik_group.deleted": {
    label: "Authentik group deleted",
    area: "access_groups",
  },
  "access.granted": { label: "Access granted", area: "access_groups" },
  "access.revoked": { label: "Access revoked", area: "access_groups" },
  "user.created": { label: "User created", area: "users" },
  "user.updated": { label: "User updated", area: "users" },
  "user.created_in_authentik": {
    label: "User created in Authentik",
    area: "users",
  },
  "user.tagged_in_authentik": {
    label: "User tagged in Authentik",
    area: "users",
  },
  "user.deactivated": { label: "User deactivated", area: "users" },
  "user.reactivated": { label: "User reactivated", area: "users" },
  "set_password.resent": { label: "Set password resent", area: "users" },
  "booking.created": { label: "Booking created", area: "bookings" },
  "booking.cancelled": { label: "Booking cancelled", area: "bookings" },
  "booking.rescheduled": { label: "Booking rescheduled", area: "bookings" },
  "booking.refused_admin_email": {
    label: "Booking refused (admin email)",
    area: "bookings",
  },
  "booking.refused_username_taken": {
    label: "Booking refused (username taken)",
    area: "bookings",
  },
  "booking.refused_duplicate_email": {
    label: "Booking refused (duplicate email)",
    area: "bookings",
  },
} as const satisfies Record<AuditAction, AuditActionInfo>;

// Every action of one area, for the `area` filter's `action in (...)`.
export const areaActions = (area: AuditArea): readonly AuditAction[] =>
  AuditAction.options.filter((a) => AUDIT_ACTION_INFO[a].area === area);

// A stored action as the page shows it. One that no longer parses keeps its
// raw name and has no area, and never breaks the page.
export type ActionView = {
  readonly name: string;
  readonly label: string;
  readonly area?: string;
};

export function actionView(action: string): ActionView {
  const parsed = AuditAction.safeParse(action);
  if (!parsed.success) return { name: action, label: action };
  const info = AUDIT_ACTION_INFO[parsed.data];
  return { name: action, label: info.label, area: AUDIT_AREA_LABEL[info.area] };
}

// AC-6: who did it. A set actor is an admin or a learner by today's role;
// a null actor is the booking form for the actions the public /book saga
// writes, and the system for everything else (worker steps, sweepers, the
// sign in check, and any action that no longer parses).
export const ActorKind = z.enum(["admin", "learner", "booking_form", "system"]);
export type ActorKind = z.infer<typeof ActorKind>;

export const ACTOR_KIND_LABEL = {
  admin: "Admin",
  learner: "Learner",
  booking_form: "Booking form",
  system: "System",
} as const satisfies Record<ActorKind, string>;

export const BOOKING_FORM_ACTIONS = [
  "booking.created",
  "booking.refused_admin_email",
  "booking.refused_username_taken",
  "booking.refused_duplicate_email",
  "user.created_in_authentik",
  "user.tagged_in_authentik",
] as const satisfies readonly AuditAction[];

const bookingForm: ReadonlySet<string> = new Set(BOOKING_FORM_ACTIONS);

export const actorKind = (role: UserRole | null, action: string): ActorKind =>
  role ?? (bookingForm.has(action) ? "booking_form" : "system");

export type DetailLine = { readonly label: string; readonly text: string };

// One entry as the page shows it (spec 0016 *API surface*). Every field is a
// plain string or array, formatted on the server, so the client row gets no
// Date and no function.
export type AuditRow = {
  readonly id: string;
  readonly time: string;
  readonly cursor: string;
  readonly actor: {
    readonly kind: ActorKind;
    readonly label: string;
    readonly userId?: string;
    readonly role?: UserRole;
  };
  readonly action: ActionView;
  readonly target: {
    readonly type: string;
    readonly id: string;
    readonly label: string;
    readonly deleted: boolean;
    readonly href: string;
  };
  readonly summary: string;
  readonly details: readonly DetailLine[];
};

export const TARGET_TYPE_LABEL = {
  testbed_type: "Testbed type",
  testbed: "Testbed",
  api_key: "API key",
  user: "User",
  booking: "Booking",
  authentik_group: "Access group",
} as const satisfies Record<AuditTargetType, string>;

export const AUDIT_LOG_PATH = "/admin/audit-log";

// AC-7: every target name links to that target's history.
export const targetHistoryHref = (type: string, id: string): string =>
  `${AUDIT_LOG_PATH}?target=${encodeURIComponent(`${type}:${id}`)}`;
