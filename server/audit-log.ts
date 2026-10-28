import "server-only";
import { sql, type Expression, type Kysely, type SqlBool } from "kysely";
import { z } from "zod";
import {
  ACTOR_KIND_LABEL,
  BOOKING_FORM_ACTIONS,
  TARGET_TYPE_LABEL,
  actionView,
  actionsMatchingLabel,
  actorKind,
  areaActions,
  describeMetadata,
  encodeCursor,
  escapeLike,
  targetHistoryHref,
  type AuditCursor,
  type AuditQuery,
  type AuditRow,
} from "@/lib/audit-log";
import { AuditTargetType, UserRole } from "@/lib/db-enums";
import { formatDateTime } from "@/lib/format-time";
import type { DB } from "@/server/db/types";

export type { AuditRow } from "@/lib/audit-log";

// Spec 0016: the read only Audit Log. Every function here runs after the
// caller's requireAdmin(), reads audit_events as stored, and writes nothing.

export const AUDIT_PAGE_SIZE = 50;

// AC-5: a removable "History for <name>" chip above the table.
export type HistoryChip = {
  readonly filter: "target" | "learner";
  readonly text: string;
};

export type AuditPage = {
  readonly rows: readonly AuditRow[];
  // Cursors for the Older and Newer links, when each should show (AC-3).
  readonly older?: string;
  readonly newer?: string;
  readonly chips: readonly HistoryChip[];
  // On a booking's history, its learner, whose history holds the revokes.
  readonly bookingNoteUserId?: string;
};

// The row's time as microsecond UTC text, made by SQL so it never passes
// through a JS Date (milliseconds only) on its way into a cursor.
const cursorTs = sql<string>`to_char(e.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

// AC-5: the three ways an entry belongs to a learner's history, each served
// by an existing index.
type LearnerArm = "actor" | "user_target" | "booking_target";
const LEARNER_ARMS: readonly LearnerArm[] = [
  "actor",
  "user_target",
  "booking_target",
];

// Every filter of the query (AC-4, AC-5), plus one learner arm, plus the
// cursor, applied in SQL, in the cursor's order, one row past a page.
const eventsQuery = (
  conn: Kysely<DB>,
  query: AuditQuery,
  timeZone: string,
  size: number,
  arm?: LearnerArm,
) =>
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
    ])
    .where((eb) => {
      const { actor, area, admin, from, to, q, target, learner, cursor } =
        query;
      const conditions: readonly (Expression<SqlBool> | undefined)[] = [
        actor === "admin" || actor === "learner"
          ? eb("actor.role", "=", actor)
          : actor === "booking_form"
            ? eb.and([
                eb("e.actor_user_id", "is", null),
                eb("e.action", "in", BOOKING_FORM_ACTIONS),
              ])
            : actor === "system"
              ? eb.and([
                  eb("e.actor_user_id", "is", null),
                  eb("e.action", "not in", BOOKING_FORM_ACTIONS),
                ])
              : undefined,
        area ? eb("e.action", "in", areaActions(area)) : undefined,
        admin ? eb("e.actor_user_id", "=", admin) : undefined,
        // Whole days in the admin's zone, converted by Postgres.
        from
          ? eb(
              "e.created_at",
              ">=",
              sql<Date>`(${from}::date)::timestamp at time zone ${timeZone}::text`,
            )
          : undefined,
        to
          ? eb(
              "e.created_at",
              "<",
              sql<Date>`(${to}::date + 1)::timestamp at time zone ${timeZone}::text`,
            )
          : undefined,
        q ? textMatch(q) : undefined,
        target
          ? eb.and([
              eb("e.target_type", "=", target.type),
              eb("e.target_id", "=", target.id),
            ])
          : undefined,
        learner && arm === "actor"
          ? eb("e.actor_user_id", "=", learner)
          : learner && arm === "user_target"
            ? eb.and([
                eb("e.target_type", "=", "user"),
                eb("e.target_id", "=", learner),
              ])
            : learner && arm === "booking_target"
              ? eb.and([
                  eb("e.target_type", "=", "booking"),
                  eb(
                    "e.target_id",
                    "in",
                    eb
                      .selectFrom("bookings")
                      .select(sql<string>`id::text`.as("id"))
                      .where("user_id", "=", learner),
                  ),
                ])
              : undefined,
        cursor ? afterCursor(cursor) : undefined,
      ];
      return eb.and(conditions.filter((c) => c !== undefined));
    })
    .orderBy("e.created_at", cursor(query) === "after" ? "asc" : "desc")
    .orderBy("e.id", cursor(query) === "after" ? "asc" : "desc")
    .limit(size + 1);

const cursor = (q: AuditQuery) => q.cursor?.dir;

// AC-3: the row value comparison the paging index serves. The time is
// compared as timestamptz, at the microseconds the cursor carries.
const afterCursor = (c: AuditCursor) =>
  c.dir === "before"
    ? sql<SqlBool>`(e.created_at, e.id) < (${c.ts}::timestamptz, ${c.id}::uuid)`
    : sql<SqlBool>`(e.created_at, e.id) > (${c.ts}::timestamptz, ${c.id}::uuid)`;

// AC-4 `q`: the summary, the action (name or label), the actor's name or
// email, and the target's name. Every id in the target union is compared as
// text, so target_id is never cast.
const textMatch = (q: string) => {
  const p = `%${escapeLike(q)}%`;
  const like = (col: string) => sql`${sql.ref(col)} ilike ${p} escape '\\'`;
  const labelled = actionsMatchingLabel(q);
  return sql<SqlBool>`(
    ${like("e.summary")}
    or ${like("e.action")}
    ${labelled.length > 0 ? sql`or e.action in (${sql.join(labelled)})` : sql``}
    or ${like("actor.name")}
    or ${like("actor.email")}
    or (e.target_type, e.target_id) in (
      select 'testbed_type', id::text from testbed_types where ${like("name")}
      union all
      select 'testbed', id::text from testbeds
        where ${like("name")} or ${like("group_name")}
      union all
      select 'api_key', id::text from api_keys where ${like("name")}
      union all
      select 'user', id::text from users where ${like("name")} or ${like("email")}
      union all
      select 'booking', b.id::text from bookings b
        join users u on u.id = b.user_id
        where ${like("u.name")} or ${like("u.email")}
      union all
      select 'authentik_group', authentik_group_pk::text from testbeds
        where authentik_group_pk is not null and ${like("group_name")}
    )
  )`;
};

type EventRow = Awaited<
  ReturnType<ReturnType<typeof eventsQuery>["execute"]>
>[number];

// Sorted the way the cursor reads: newest first, or oldest first after an
// `after` cursor. The time text is fixed width UTC, so it sorts as text,
// and uuid order is the order of their lowercase text.
const compareRows =
  (dir: "asc" | "desc") =>
  (a: EventRow, b: EventRow): number => {
    const order =
      a.cursor_ts === b.cursor_ts
        ? a.id < b.id
          ? -1
          : a.id > b.id
            ? 1
            : 0
        : a.cursor_ts < b.cursor_ts
          ? -1
          : 1;
    return dir === "asc" ? order : -order;
  };

// One page plus one row, in the cursor's order. A learner's history reads
// its three arms, each limited the same way, then merges them (a row can be
// in more than one arm) and keeps the first size plus one.
async function fetchEvents(
  conn: Kysely<DB>,
  query: AuditQuery,
  timeZone: string,
  size: number,
): Promise<readonly EventRow[]> {
  if (!query.learner) return eventsQuery(conn, query, timeZone, size).execute();
  const arms = await Promise.all(
    LEARNER_ARMS.map((arm) =>
      eventsQuery(conn, query, timeZone, size, arm).execute(),
    ),
  );
  const unique = [...new Map(arms.flat().map((row) => [row.id, row])).values()];
  return unique
    .sort(compareRows(cursor(query) === "after" ? "asc" : "desc"))
    .slice(0, size + 1);
}

// AC-2, AC-3: one page of entries, newest first, with the Older and Newer
// cursors the link rules allow.
export async function listAuditEvents(
  conn: Kysely<DB>,
  query: AuditQuery,
  timeZone: string,
): Promise<AuditPage> {
  const [found, chips, bookingNoteUserId] = await Promise.all([
    fetchEvents(conn, query, timeZone, AUDIT_PAGE_SIZE),
    historyChips(conn, query, timeZone),
    query.target?.type === "booking"
      ? conn
          .selectFrom("bookings")
          .select("user_id")
          .where("id", "=", query.target.id)
          .executeTakeFirst()
          .then((b) => b?.user_id)
      : undefined,
  ]);
  const more = found.length > AUDIT_PAGE_SIZE;
  const page = found.slice(0, AUDIT_PAGE_SIZE);
  const rows = await toRows(
    conn,
    query.cursor?.dir === "after" ? page.toReversed() : page,
    timeZone,
  );
  const first = rows.at(0)?.cursor;
  const last = rows.at(-1)?.cursor;
  // An empty page past a cursor links back across that same cursor.
  const self = query.cursor && encodeCursor(query.cursor.ts, query.cursor.id);
  const links =
    query.cursor?.dir === "before"
      ? { older: more ? last : undefined, newer: first ?? self }
      : query.cursor?.dir === "after"
        ? { older: last ?? self, newer: more ? first : undefined }
        : { older: more ? last : undefined, newer: undefined };
  return {
    rows,
    ...(links.older ? { older: links.older } : {}),
    ...(links.newer ? { newer: links.newer } : {}),
    chips,
    ...(bookingNoteUserId ? { bookingNoteUserId } : {}),
  };
}

// The chips name their filter through resolveTargets, as a row would.
async function historyChips(
  conn: Kysely<DB>,
  query: AuditQuery,
  timeZone: string,
): Promise<readonly HistoryChip[]> {
  const wanted: readonly {
    readonly filter: HistoryChip["filter"];
    readonly type: string;
    readonly id: string;
  }[] = [
    ...(query.target ? [{ filter: "target" as const, ...query.target }] : []),
    ...(query.learner
      ? [{ filter: "learner" as const, type: "user", id: query.learner }]
      : []),
  ];
  if (wanted.length === 0) return [];
  const labels = await resolveTargets(conn, wanted, timeZone);
  return wanted.map((w) => {
    const label = labels.get(targetKey(w.type, w.id)) ?? notFound(w.type);
    return {
      filter: w.filter,
      text: label.found ? `History for ${label.label}` : label.label,
    };
  });
}

// AC-10: a learner's newest entries for their detail page, by the same
// three arm rule as the `learner` filter.
export async function learnerHistory(
  conn: Kysely<DB>,
  userId: string,
  timeZone: string,
  limit: number,
): Promise<readonly AuditRow[]> {
  const found = await fetchEvents(conn, { learner: userId }, timeZone, limit);
  return toRows(conn, found.slice(0, limit), timeZone);
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
      details: describeMetadata(e.metadata),
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

// A string `featureName` in an entry's metadata (a removed reset step).
const metadataFeatureName = (metadata: unknown): string | undefined => {
  const parsed = z.object({ featureName: z.string() }).safeParse(metadata);
  return parsed.success ? parsed.data.featureName : undefined;
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
  const [types, testbeds, keys, users, bookings, groups, resetSteps, runs] =
    await Promise.all([
      namedRows(conn, "testbed_types", idsOf("testbed_type")),
      inList(idsOf("testbed"), (ids) =>
        conn
          .selectFrom("testbeds")
          .select(["id", "name", "group_name", "deleted_at"])
          .where("id", "in", ids)
          .execute(),
      ),
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
          .select(["authentik_group_pk", "group_name"])
          // A uuid column, but a target_id may be any text: compare as text.
          .where(sql<string>`authentik_group_pk::text`, "in", pks)
          .execute(),
      ),
      // Spec 0022: a reset step, named by its live row.
      inList(idsOf("portal_reset_step"), (ids) =>
        conn
          .selectFrom("portal_reset_steps")
          .select(["id", "feature_name"])
          .where("id", "in", ids)
          .execute(),
      ),
      // Spec 0023: a reset run, "Reset of <testbed> at <time>". Runs are
      // purged after 30 days, then the row keeps the not found fallback.
      inList(idsOf("portal_reset_run"), (ids) =>
        conn
          .selectFrom("portal_reset_runs as r")
          .innerJoin("testbeds as t", "t.id", "r.testbed_id")
          .select(["r.id", "r.lab_ended_at", "t.name"])
          .where("r.id", "in", ids)
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
    put(
      "testbed",
      r.id,
      named(
        r.name === r.group_name ? r.name : `${r.name} (group ${r.group_name})`,
        r.deleted_at !== null,
      ),
    ),
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
        named(`${r.group_name} access group`),
      );
  });

  resetSteps.forEach((r) =>
    put("portal_reset_step", r.id, named(`Reset step ${r.feature_name}`)),
  );

  runs.forEach((r) =>
    put(
      "portal_reset_run",
      r.id,
      named(
        `Reset of ${r.name} at ${formatDateTime(r.lab_ended_at, timeZone)}`,
      ),
    ),
  );

  refs.forEach((r) => {
    const key = targetKey(r.type, r.id);
    if (labels.has(key)) return;
    const pk = AUTHENTIK_USER.exec(r.id)?.[1];
    if (r.type === "user" && pk !== undefined)
      labels.set(key, named(`Authentik user ${pk}`));
    else if (r.type === "user" && r.id === "unknown")
      labels.set(key, named("Unknown"));
    else if (r.type === "portal_reset_settings")
      labels.set(key, named("Nile Portal Reset settings"));
    else if (r.type === "portal_reset_step") {
      // A removed step keeps its name in the audit row's metadata.
      const name = metadataFeatureName(r.metadata);
      if (name !== undefined)
        labels.set(key, named(`Reset step ${name}`, true));
    } else if (r.type === "authentik_group") {
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
  table: "testbed_types" | "api_keys",
  ids: readonly string[],
) =>
  inList(ids, (list) =>
    conn
      .selectFrom(table)
      .select(["id", "name", "deleted_at"])
      .where("id", "in", list)
      .execute(),
  );

// AC-4: the `admin` filter's picker, every admin by name.
export const listAdmins = (
  conn: Kysely<DB>,
): Promise<readonly { readonly id: string; readonly name: string }[]> =>
  conn
    .selectFrom("users")
    .select(["id", "name"])
    .where("role", "=", "admin")
    .orderBy("name")
    .orderBy("id")
    .execute();
