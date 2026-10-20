import "server-only";
import { sql, type Kysely } from "kysely";
import { z } from "zod";
import {
  ACTOR_KIND_LABEL,
  TARGET_TYPE_LABEL,
  actionView,
  actorKind,
  targetHistoryHref,
  type AuditRow,
} from "@/lib/audit-log";
import { AuditTargetType, UserRole } from "@/lib/db-enums";
import { formatDateTime } from "@/lib/format-time";

export type { AuditRow } from "@/lib/audit-log";
import type { DB } from "@/server/db/types";

// Spec 0016: the read only Audit Log. Every function here runs after the
// caller's requireAdmin(), reads audit_events as stored, and writes nothing.

export const AUDIT_PAGE_SIZE = 50;

export type AuditPage = {
  readonly rows: readonly AuditRow[];
  readonly older?: string;
};

// The boundary row's time as microsecond UTC text, made by SQL so it never
// passes through a JS Date (milliseconds only), and the cursor built on it.
const cursorTs = sql<string>`to_char(e.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export const encodeCursor = (ts: string, id: string): string =>
  Buffer.from(`${ts}|${id}`).toString("base64url");

const selectEvents = (conn: Kysely<DB>) =>
  conn
    .selectFrom("audit_events as e")
    .leftJoin("users as actor", "actor.id", "e.actor_user_id")
    .select([
      "e.id",
      "e.created_at",
      "e.action",
      "e.target_type",
      "e.target_id",
      "e.summary",
      "e.metadata",
      "e.actor_user_id",
      "actor.name as actor_name",
      "actor.role as actor_role",
      cursorTs.as("cursor_ts"),
    ]);

type EventRow = Awaited<
  ReturnType<ReturnType<typeof selectEvents>["execute"]>
>[number];

// AC-2: the newest page, ordered by (created_at, id) so ties never shuffle.
export async function listAuditEvents(
  conn: Kysely<DB>,
  timeZone: string,
): Promise<AuditPage> {
  const found = await selectEvents(conn)
    .orderBy("e.created_at", "desc")
    .orderBy("e.id", "desc")
    .limit(AUDIT_PAGE_SIZE + 1)
    .execute();
  const shown = found.slice(0, AUDIT_PAGE_SIZE);
  const rows = await toRows(conn, shown, timeZone);
  const last = rows.at(-1);
  return {
    rows,
    ...(found.length > AUDIT_PAGE_SIZE && last ? { older: last.cursor } : {}),
  };
}

async function toRows(
  conn: Kysely<DB>,
  events: readonly EventRow[],
  timeZone: string,
): Promise<readonly AuditRow[]> {
  const targets = await resolveTargets(
    conn,
    events.map((e) => ({
      type: e.target_type,
      id: e.target_id,
      metadata: e.metadata,
    })),
    timeZone,
  );
  return events.map((e) => {
    const role = e.actor_role === null ? null : UserRole.parse(e.actor_role);
    const kind = actorKind(role, e.action);
    const key = targetKey(e.target_type, e.target_id);
    const target = targets.get(key) ?? notFound(e.target_type);
    return {
      id: e.id,
      time: formatDateTime(e.created_at, timeZone),
      cursor: encodeCursor(e.cursor_ts, e.id),
      actor: {
        kind,
        label: e.actor_name ?? ACTOR_KIND_LABEL[kind],
        ...(e.actor_user_id === null ? {} : { userId: e.actor_user_id }),
        ...(role === null ? {} : { role }),
      },
      action: actionView(e.action),
      target: {
        type: e.target_type,
        id: e.target_id,
        label: target.label,
        deleted: target.deleted,
        href: targetHistoryHref(e.target_type, e.target_id),
      },
      summary: e.summary,
      details: [],
    };
  });
}

export type TargetRef = {
  readonly type: string;
  readonly id: string;
  readonly metadata?: unknown;
};

export type TargetLabel = {
  readonly label: string;
  readonly deleted: boolean;
  // False when no row matched, so the label is "<type> (not found)".
  readonly found: boolean;
};

export const targetKey = (type: string, id: string) => `${type}:${id}`;

const notFound = (type: string): TargetLabel => {
  const parsed = AuditTargetType.safeParse(type);
  return {
    label: `${parsed.success ? TARGET_TYPE_LABEL[parsed.data] : type} (not found)`,
    deleted: false,
    found: false,
  };
};

const named = (label: string, deleted = false): TargetLabel => ({
  label,
  deleted,
  found: true,
});

const isUuid = (id: string) => z.uuid().safeParse(id).success;

const AUTHENTIK_USER = /^authentik:(\d+)$/;

// A string `name` in an entry's metadata (an undone group create keeps it).
const metadataName = (metadata: unknown): string | undefined => {
  const parsed = z.object({ name: z.string() }).safeParse(metadata);
  return parsed.success ? parsed.data.name : undefined;
};

// AC-7: target names in one batched read per type, after the page loads its
// rows. Ids are checked with z.uuid() before they reach SQL, so target_id is
// never cast; anything with no row gets a fallback label.
export async function resolveTargets(
  conn: Kysely<DB>,
  refs: readonly TargetRef[],
  timeZone: string,
): Promise<ReadonlyMap<string, TargetLabel>> {
  const idsOf = (type: AuditTargetType) => [
    ...new Set(
      refs.filter((r) => r.type === type && isUuid(r.id)).map((r) => r.id),
    ),
  ];
  const groupPks = [
    ...new Set(
      refs.filter((r) => r.type === "authentik_group").map((r) => r.id),
    ),
  ];
  const [types, testbeds, keys, users, bookings, groups] = await Promise.all([
    namedRows(conn, "testbed_types", idsOf("testbed_type")),
    namedRows(conn, "testbeds", idsOf("testbed")),
    namedRows(conn, "api_keys", idsOf("api_key")),
    inList(idsOf("user"), (ids) =>
      conn
        .selectFrom("users")
        .select(["id", "name", "email", "role"])
        .where("id", "in", ids)
        .execute(),
    ),
    inList(idsOf("booking"), (ids) =>
      conn
        .selectFrom("bookings as b")
        .innerJoin("users as u", "u.id", "b.user_id")
        .innerJoin("testbeds as t", "t.id", "b.testbed_id")
        .select([
          "b.id",
          "b.starts_at",
          "u.name as learner",
          "t.name as testbed",
          "t.deleted_at",
        ])
        .where("b.id", "in", ids)
        .execute(),
    ),
    inList(groupPks, (pks) =>
      conn
        .selectFrom("testbeds")
        .select(["authentik_group_pk", "name"])
        // A uuid column, but a target_id may be any text: compare as text.
        .where(sql<string>`authentik_group_pk::text`, "in", pks)
        .execute(),
    ),
  ]);

  const labels = new Map<string, TargetLabel>();
  const put = (type: AuditTargetType, id: string, label: TargetLabel) =>
    labels.set(targetKey(type, id), label);

  types.forEach((r) =>
    put("testbed_type", r.id, named(r.name, r.deleted_at !== null)),
  );
  testbeds.forEach((r) =>
    put("testbed", r.id, named(r.name, r.deleted_at !== null)),
  );
  keys.forEach((r) =>
    put("api_key", r.id, named(r.name, r.deleted_at !== null)),
  );
  users.forEach((r) =>
    put(
      "user",
      r.id,
      named(`${r.name} · ${r.email}${r.role === "admin" ? " (admin)" : ""}`),
    ),
  );
  bookings.forEach((r) =>
    put(
      "booking",
      r.id,
      named(
        [
          r.learner,
          `${r.testbed}${r.deleted_at === null ? "" : " (deleted testbed)"}`,
          formatDateTime(r.starts_at, timeZone),
        ].join(" · "),
      ),
    ),
  );
  groups.forEach((r) => {
    if (r.authentik_group_pk !== null)
      put(
        "authentik_group",
        r.authentik_group_pk,
        named(`${r.name} access group`),
      );
  });

  refs.forEach((r) => {
    const key = targetKey(r.type, r.id);
    if (labels.has(key)) return;
    const pk = AUTHENTIK_USER.exec(r.id)?.[1];
    if (r.type === "user" && pk !== undefined)
      labels.set(key, named(`Authentik user ${pk}`));
    else if (r.type === "user" && r.id === "unknown")
      labels.set(key, named("Unknown"));
    else if (r.type === "authentik_group") {
      const name = metadataName(r.metadata);
      if (name !== undefined) labels.set(key, named(`${name} access group`));
    }
  });
  refs.forEach((r) => {
    const key = targetKey(r.type, r.id);
    if (!labels.has(key)) labels.set(key, notFound(r.type));
  });
  return labels;
}

// Skips the query for an empty list (`in ()` is not SQL).
const inList = async <T>(
  ids: readonly string[],
  read: (ids: readonly string[]) => Promise<T[]>,
): Promise<T[]> => (ids.length === 0 ? [] : read(ids));

const namedRows = (
  conn: Kysely<DB>,
  table: "testbed_types" | "testbeds" | "api_keys",
  ids: readonly string[],
) =>
  inList(ids, (list) =>
    conn
      .selectFrom(table)
      .select(["id", "name", "deleted_at"])
      .where("id", "in", list)
      .execute(),
  );
