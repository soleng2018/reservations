import "server-only";
import { sql, type Kysely } from "kysely";
import { z } from "zod";
import {
  PortalResetAbortReason,
  PortalResetItemKind,
  PortalResetRunMode,
  PortalResetRunState,
  PortalResetSignInReason,
} from "@/lib/db-enums";
import { ITEMS_PAGE, RUNS_LIMIT } from "@/lib/portal-reset/runs-view";
import type { DB } from "@/server/db/types";

// Spec 0023 AC-32: what the Recent resets pages read. Read only. A run's
// records hold labels the list names, route patterns, statuses, and redacted
// messages already (AC-30); nothing else is selected here.

export type RunRow = {
  readonly id: string;
  readonly testbedName: string;
  readonly domain: string | null;
  readonly labEndedAt: Date;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
  readonly mode: PortalResetRunMode;
  readonly state: PortalResetRunState;
  readonly abortReason: PortalResetAbortReason | null;
  readonly signInReason: PortalResetSignInReason | null;
  readonly counts: Readonly<Record<string, number>>;
};

export type ItemRow = {
  readonly seq: number;
  readonly stepKey: string;
  readonly kind: PortalResetItemKind;
  readonly label: string | null;
  readonly itemId: string | null;
  readonly method: string | null;
  readonly route: string | null;
  readonly status: number | null;
  readonly message: string | null;
  readonly pass: number;
  readonly resolved: boolean;
};

const Counts = z.record(z.string(), z.number());

type RawRun = {
  id: string;
  testbed_name: string;
  domain: string | null;
  lab_ended_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  mode: string;
  state: string;
  abort_reason: string | null;
  sign_in_reason: string | null;
  counts: unknown;
};

const toRun = (r: RawRun): RunRow => {
  const counts = Counts.safeParse(r.counts);
  return {
    id: r.id,
    testbedName: r.testbed_name,
    domain: r.domain,
    labEndedAt: r.lab_ended_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    mode: PortalResetRunMode.parse(r.mode),
    state: PortalResetRunState.parse(r.state),
    abortReason:
      r.abort_reason === null
        ? null
        : PortalResetAbortReason.parse(r.abort_reason),
    signInReason:
      r.sign_in_reason === null
        ? null
        : PortalResetSignInReason.parse(r.sign_in_reason),
    counts: counts.success ? counts.data : {},
  };
};

const runColumns = sql`
  r.id, t.name as testbed_name, t.domain, r.lab_ended_at, r.started_at,
  r.finished_at, r.mode, r.state, r.abort_reason, r.sign_in_reason, r.counts`;

// The last 50 runs, newest lab end first.
export async function listRuns(conn: Kysely<DB>): Promise<readonly RunRow[]> {
  const { rows } = await sql<RawRun>`
    select ${runColumns}
    from hol_app.portal_reset_runs r
    join hol_app.testbeds t on t.id = r.testbed_id
    order by r.lab_ended_at desc, r.created_at desc
    limit ${RUNS_LIMIT}`.execute(conn);
  return rows.map(toRun);
}

export type RunDetail = {
  readonly run: RunRow;
  readonly items: readonly ItemRow[];
  readonly total: number;
  readonly page: number;
  readonly pages: number;
};

// One run and a page of its records (200 a page, in the order they happened).
export async function readRun(
  conn: Kysely<DB>,
  id: string,
  page: number,
): Promise<RunDetail | undefined> {
  const found = await sql<RawRun>`
    select ${runColumns}
    from hol_app.portal_reset_runs r
    join hol_app.testbeds t on t.id = r.testbed_id
    where r.id = ${id}::uuid`.execute(conn);
  const raw = found.rows[0];
  if (!raw) return undefined;
  const total = await conn
    .selectFrom("portal_reset_run_items")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("run_id", "=", id)
    .executeTakeFirst();
  const count = Number(total?.n ?? 0);
  const pages = Math.max(1, Math.ceil(count / ITEMS_PAGE));
  const at = Math.min(page, pages);
  const items = await conn
    .selectFrom("portal_reset_run_items")
    .select([
      "seq",
      "step_key",
      "kind",
      "label",
      "item_id",
      "method",
      "route",
      "status",
      "message",
      "pass",
      "resolved",
    ])
    .where("run_id", "=", id)
    .orderBy("seq")
    .limit(ITEMS_PAGE)
    .offset((at - 1) * ITEMS_PAGE)
    .execute();
  return {
    run: toRun(raw),
    items: items.map((i) => ({
      seq: i.seq,
      stepKey: i.step_key,
      kind: PortalResetItemKind.parse(i.kind),
      label: i.label,
      itemId: i.item_id,
      method: i.method,
      route: i.route,
      status: i.status,
      message: i.message,
      pass: i.pass,
      resolved: i.resolved,
    })),
    total: count,
    page: at,
    pages,
  };
}
