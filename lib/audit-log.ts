import { z } from "zod";
import { AuditAction } from "@/lib/audit-actions";
import { AuditTargetType, type UserRole } from "@/lib/db-enums";

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
  "authentik_group.released": {
    label: "Authentik group released",
    area: "access_groups",
  },
  "testbed.group_relinked": {
    label: "Testbed group found again",
    area: "testbeds",
  },
  "user.nile_login_set": { label: "Nile login set", area: "users" },
  "user.nile_login_conflict": {
    label: "Nile login taken in Authentik",
    area: "users",
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

// Free text matches an action by its label too (AC-4): the actions whose
// label contains the text, case insensitive.
export const actionsMatchingLabel = (q: string): readonly AuditAction[] =>
  AuditAction.options.filter((a) =>
    AUDIT_ACTION_INFO[a].label.toLowerCase().includes(q.toLowerCase()),
  );

// `\`, `%`, and `_` taken literally by ILIKE ... ESCAPE '\'.
export const escapeLike = (q: string): string =>
  q.replace(/[\\%_]/g, (c) => `\\${c}`);

// AC-3: the keyset cursor, base64url of "<microsecond UTC time>|<id>".
export type AuditCursor = {
  readonly dir: "before" | "after";
  readonly ts: string;
  readonly id: string;
};

export const encodeCursor = (ts: string, id: string): string =>
  btoa(`${ts}|${id}`)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

// From 1970 on: a forged year 0000 would pass the format but not Postgres.
const sinceEpoch = (s: string) => s >= "1970";
const CursorTime = z.iso.datetime({ precision: 6 }).refine(sinceEpoch);
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export function decodeCursor(
  raw: string,
): Omit<AuditCursor, "dir"> | undefined {
  if (!BASE64URL.test(raw)) return undefined;
  const text = (() => {
    try {
      return atob(raw.replace(/-/g, "+").replace(/_/g, "/"));
    } catch {
      return undefined;
    }
  })();
  const parts = text?.split("|") ?? [];
  if (parts.length !== 2) return undefined;
  const [ts, id] = parts;
  return CursorTime.safeParse(ts).success && z.uuid().safeParse(id).success
    ? { ts, id }
    : undefined;
}

// AC-5: a history target, `<type>:<id>` split on its first colon.
export type AuditTarget = {
  readonly type: AuditTargetType;
  readonly id: string;
};

const UUID_TARGETS: ReadonlySet<AuditTargetType> = new Set([
  "testbed_type",
  "testbed",
  "api_key",
  "booking",
]);
const SPECIAL_USER = /^(?:authentik:\d{1,18}|unknown)$/;
const GROUP_ID = /^[A-Za-z0-9-]{1,64}$/;
const isUuid = (s: string) => z.uuid().safeParse(s).success;

export function parseTarget(raw: string): AuditTarget | undefined {
  const colon = raw.indexOf(":");
  if (colon < 0) return undefined;
  const type = AuditTargetType.safeParse(raw.slice(0, colon));
  const id = raw.slice(colon + 1);
  if (!type.success) return undefined;
  const fits = UUID_TARGETS.has(type.data)
    ? isUuid(id)
    : type.data === "user"
      ? isUuid(id) || SPECIAL_USER.test(id)
      : GROUP_ID.test(id);
  return fits ? { type: type.data, id } : undefined;
}

export type AuditQuery = {
  readonly actor?: ActorKind;
  readonly area?: AuditArea;
  readonly admin?: string;
  readonly from?: string;
  readonly to?: string;
  readonly q?: string;
  readonly target?: AuditTarget;
  readonly learner?: string;
  readonly cursor?: AuditCursor;
};

export type SearchParams = Readonly<
  Record<string, string | readonly string[] | undefined>
>;

// A param given more than once uses its first value; an empty one (an
// unset control of the GET form) is absent, not invalid.
const firstValue = (v: string | readonly string[] | undefined) => {
  const s = typeof v === "string" ? v : v?.[0];
  return s === undefined || s === "" ? undefined : s;
};

const IsoDay = z.iso.date().refine(sinceEpoch);
const Q = z
  .string()
  .min(2)
  .max(100)
  .refine((s) => !s.includes("\u0000"));

const fromSchema =
  <T>(schema: z.ZodType<T>) =>
  (raw: string): T | undefined => {
    const parsed = schema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  };

// One parser per param (AC-4); each returns undefined for a bad value.
const PARSERS = {
  actor: fromSchema(ActorKind),
  area: fromSchema(AuditArea),
  admin: fromSchema(z.uuid()),
  from: fromSchema(IsoDay),
  to: fromSchema(IsoDay),
  q: fromSchema(Q),
  target: parseTarget,
  learner: fromSchema(z.uuid()),
  before: decodeCursor,
  after: decodeCursor,
} as const;

type ParamName = keyof typeof PARSERS;
type ParsedParams = {
  readonly [K in ParamName]?: NonNullable<ReturnType<(typeof PARSERS)[K]>>;
};

// AC-4, AC-14: the page's query from its URL. Never throws: a param that
// fails to parse is dropped and named in `dropped`, so the page shows one
// notice and the rest of the filters still apply.
export function parseAuditQuery(params: SearchParams): {
  readonly query: AuditQuery;
  readonly dropped: readonly string[];
} {
  const names = Object.keys(PARSERS) as ParamName[];
  const raw = Object.fromEntries(
    names.map((n) => {
      const v = firstValue(params[n]);
      return [n, n === "q" && v !== undefined ? v.trim() || undefined : v];
    }),
  ) as Readonly<Record<ParamName, string | undefined>>;
  const parsed = Object.fromEntries(
    names.flatMap((n) => {
      const v = raw[n];
      const p = v === undefined ? undefined : PARSERS[n](v);
      return p === undefined ? [] : [[n, p]];
    }),
  ) as ParsedParams;
  const bad = names.filter((n) => raw[n] !== undefined && !(n in parsed));

  // Pairs that cannot hold together are dropped whole.
  const backwards =
    parsed.from !== undefined &&
    parsed.to !== undefined &&
    parsed.from > parsed.to;
  const bothCursors = raw.before !== undefined && raw.after !== undefined;
  const pairDropped = [
    ...(backwards ? ["from", "to"] : []),
    ...(bothCursors ? ["before", "after"] : []),
  ];
  const kept = (n: ParamName) => !pairDropped.includes(n);
  const cursor = !kept("before")
    ? undefined
    : parsed.before
      ? ({ dir: "before", ...parsed.before } as const)
      : parsed.after
        ? ({ dir: "after", ...parsed.after } as const)
        : undefined;

  return {
    query: {
      ...(parsed.actor ? { actor: parsed.actor } : {}),
      ...(parsed.area ? { area: parsed.area } : {}),
      ...(parsed.admin ? { admin: parsed.admin } : {}),
      ...(parsed.from && kept("from") ? { from: parsed.from } : {}),
      ...(parsed.to && kept("to") ? { to: parsed.to } : {}),
      ...(parsed.q ? { q: parsed.q } : {}),
      ...(parsed.target ? { target: parsed.target } : {}),
      ...(parsed.learner ? { learner: parsed.learner } : {}),
      ...(cursor ? { cursor } : {}),
    },
    dropped: [...new Set([...bad, ...pairDropped])],
  };
}

// AC-14: the one notice for any dropped param.
export const DROPPED_NOTICE =
  "Some filters in this link weren't valid and were ignored.";

export const hasFilters = (q: AuditQuery): boolean =>
  [q.actor, q.area, q.admin, q.from, q.to, q.q, q.target, q.learner].some(
    (v) => v !== undefined,
  );

// A link to the log with these filters. The query's own cursor is never
// carried: applying or clearing a filter starts from the newest page, and
// the paging links pass their cursor explicitly.
export function auditHref(
  q: AuditQuery,
  page: { readonly before?: string; readonly after?: string } = {},
): string {
  const pairs: readonly (readonly [string, string | undefined])[] = [
    ["actor", q.actor],
    ["area", q.area],
    ["admin", q.admin],
    ["from", q.from],
    ["to", q.to],
    ["q", q.q],
    ["target", q.target && `${q.target.type}:${q.target.id}`],
    ["learner", q.learner],
    ["before", page.before],
    ["after", page.after],
  ];
  const search = new URLSearchParams(
    pairs.flatMap(([k, v]) => (v === undefined ? [] : [[k, v]])),
  ).toString();
  return search ? `${AUDIT_LOG_PATH}?${search}` : AUDIT_LOG_PATH;
}

// AC-8: the field labels of an entry's details.
export const METADATA_LABELS: Readonly<Record<string, string>> = {
  name: "Name",
  durationValue: "Duration value",
  durationUnit: "Duration unit",
  type: "Type",
  baseUrl: "Base URL",
  slug: "Slug",
  clients: "Clients",
  email: "Email",
  company: "Company",
  timezone: "Timezone",
  phase: "Phase",
  source: "Source",
  fromStartsAt: "Was starting",
  toStartsAt: "Now starting",
  fromTestbedId: "Was testbed",
  toTestbedId: "Now testbed",
  testbedId: "Testbed",
  userId: "User",
  groupPk: "Access group",
  authentikUserPk: "Authentik user",
  authentikSynced: "Synced to Authentik",
  reusedAuthentikUser: "Reused Authentik user",
  sessionsEnded: "Sessions ended",
  vmRevoke: "Lab session revoke",
};

// No writer stores one, but a secret looking key is never shown anyway.
const SECRET_KEY = /secret|password|token|ciphertext/i;

// "googleMethod" → "Google method", for a key with no label.
const keyLabel = (key: string): string => {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\s]+/g, " ")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const valueText = (v: unknown): string =>
  v === null || v === undefined
    ? "empty"
    : typeof v === "boolean"
      ? v
        ? "yes"
        : "no"
      : typeof v === "string"
        ? v
        : typeof v === "number"
          ? String(v)
          : JSON.stringify(v);

// The changedFields shape: exactly { from, to }.
const isChange = (
  v: unknown,
): v is { readonly from: unknown; readonly to: unknown } =>
  isRecord(v) && Object.keys(v).length === 2 && "from" in v && "to" in v;

// AC-8: an entry's metadata as readable lines, one per key, in stored
// order. A non object (or an empty one) has no lines.
export const describeMetadata = (metadata: unknown): readonly DetailLine[] =>
  isRecord(metadata)
    ? Object.entries(metadata)
        .filter(([key]) => !SECRET_KEY.test(key))
        .map(([key, value]) => ({
          label: METADATA_LABELS[key] ?? keyLabel(key),
          text: isChange(value)
            ? `${valueText(value.from)} → ${valueText(value.to)}`
            : valueText(value),
        }))
    : [];
