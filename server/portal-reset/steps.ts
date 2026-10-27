import "server-only";
import { sql, type Kysely, type Transaction } from "kysely";
import { PortalResetMode } from "@/lib/db-enums";
import { fieldErrors, type FieldErrors } from "@/lib/form-errors";
import {
  computeDiff,
  emailSummary,
  modeSummary,
  type SaveDiff,
} from "@/lib/portal-reset/diff";
import { type SaveRefusalKind } from "@/lib/portal-reset/messages";
import { SaveRequest } from "@/lib/portal-reset/save-input";
import { StepDefinition } from "@/lib/portal-reset/step-schema";
import { err, type Result } from "@/lib/result";
import { audit } from "@/server/audit";
import { mapConstraintError } from "@/server/db/constraint-errors";
import { Refusal, refusable } from "@/server/db/refusal";
import type { DB } from "@/server/db/types";
import { startingList } from "./starting-list";

// Reads of the reset list (spec 0022 AC-16). The engine and the admin page
// both read through here, so neither sees a Save half way: the settings row
// and the steps come from one REPEATABLE READ snapshot.

export type ResetStep = {
  readonly id: string;
  readonly position: number;
  readonly featureName: string;
  readonly enabled: boolean;
  readonly note: string | null;
  readonly seedKey: string | null;
  readonly definition: StepDefinition;
};

// A row whose definition no longer parses comes back as `{ ok: false }`, so
// the engine stops loudly (spec 0023 AC-17) instead of skipping it.
export type ResetStepRead =
  | { readonly ok: true; readonly step: ResetStep }
  | {
      readonly ok: false;
      readonly id: string;
      readonly position: number;
      readonly featureName: string;
      readonly enabled: boolean;
      readonly note: string | null;
      // The stored JSON as it is, so the admin page can show it for a fix.
      // The engine only looks at `ok`.
      readonly definition: unknown;
      readonly error: "invalid_definition";
    };

export type ResetList = {
  readonly version: number;
  readonly abortEmail: string | null;
  readonly mode: PortalResetMode;
  readonly steps: readonly ResetStepRead[];
};

// What the admin page adds: who saved last and when, for the "Last saved"
// line. Same snapshot as the list, so the version the page binds to a Save
// matches the rows it shows.
export type ResetPage = ResetList & {
  readonly updatedAt: Date;
  readonly updatedByName: string | null;
};

async function readSnapshot(trx: Transaction<DB>): Promise<ResetPage> {
  const settings = await trx
    .selectFrom("portal_reset_settings as s")
    .leftJoin("users as u", "u.id", "s.updated_by")
    .select([
      "s.version",
      "s.abort_email",
      "s.mode",
      "s.updated_at",
      "s.updated_by",
      "u.name as updated_by_name",
    ])
    .executeTakeFirstOrThrow();
  const rows = await trx
    .selectFrom("portal_reset_steps")
    .selectAll()
    .orderBy("position")
    .execute();
  return {
    version: settings.version,
    abortEmail: settings.abort_email,
    mode: PortalResetMode.parse(settings.mode),
    updatedAt: settings.updated_at,
    updatedByName:
      settings.updated_by === null
        ? null
        : (settings.updated_by_name ?? "a removed user"),
    steps: rows.map((row): ResetStepRead => {
      const definition = StepDefinition.safeParse(row.definition);
      return definition.success
        ? {
            ok: true,
            step: {
              id: row.id,
              position: row.position,
              featureName: row.feature_name,
              enabled: row.enabled,
              note: row.note,
              seedKey: row.seed_key,
              definition: definition.data,
            },
          }
        : {
            ok: false,
            id: row.id,
            position: row.position,
            featureName: row.feature_name,
            enabled: row.enabled,
            note: row.note,
            definition: row.definition,
            error: "invalid_definition",
          };
    }),
  };
}

const snapshot = (conn: Kysely<DB>): Promise<ResetPage> =>
  conn
    .transaction()
    .setIsolationLevel("repeatable read")
    .execute((trx) => readSnapshot(trx));

// The engine's read: settings and steps in order from one snapshot.
export async function readResetList(conn: Kysely<DB>): Promise<ResetList> {
  const { version, abortEmail, mode, steps } = await snapshot(conn);
  return { version, abortEmail, mode, steps };
}

// The admin page's read (the thin `listResetSteps` and `getResetSettings` of
// the spec in one call, so the version and the rows cannot differ).
export const readResetPage = snapshot;

// --- Save (spec 0022 AC-7, AC-9, AC-11, AC-12) ---

export type SaveError =
  | { readonly kind: "invalid"; readonly fields: FieldErrors }
  // stale: another admin saved after this page loaded. unknown_step: a
  // submitted id is not a row of the list. duplicate_step: an id or a
  // starting list key is used twice, or a key is already in use. bad_seed_key:
  // a key that is not in the file, or sent with an existing row.
  // duplicate_name: the name index caught a repeat the checks did not.
  | { readonly kind: SaveRefusalKind };

export type SaveOutcome = {
  // The version now stored: unchanged when the Save changed nothing.
  readonly version: number;
  readonly changed: boolean;
};

type SaveRefusal = Exclude<SaveRefusalKind, "duplicate_name">;

// Writes the email, the mode, and the whole list in one transaction. The
// settings row is locked first and its version checked, so two admins cannot
// overwrite each other (lock first pattern). `input` is untrusted: it is
// normalized and parsed here, and a refusal writes nothing.
export async function savePortalReset(
  conn: Kysely<DB>,
  input: unknown,
  adminId: string,
): Promise<Result<SaveOutcome, SaveError>> {
  const parsed = SaveRequest.safeParse(input);
  if (!parsed.success) {
    return err({ kind: "invalid", fields: fieldErrors(parsed.error) });
  }
  const request = parsed.data;
  try {
    const saved = await refusable<SaveOutcome, SaveRefusal>(() =>
      conn.transaction().execute((trx) => writeSave(trx, request, adminId)),
    );
    return saved.ok ? saved : err({ kind: saved.error });
  } catch (e) {
    // A deferred or unique constraint fails at commit, outside `refusable`.
    const mapped = mapConstraintError(e);
    if (
      !mapped.ok &&
      (mapped.error === "duplicate_name" || mapped.error === "duplicate_step")
    ) {
      return err({ kind: mapped.error });
    }
    throw e;
  }
}

async function writeSave(
  trx: Transaction<DB>,
  request: SaveRequest,
  adminId: string,
): Promise<SaveOutcome> {
  const settings = await trx
    .selectFrom("portal_reset_settings")
    .select(["version", "abort_email", "mode"])
    .forUpdate()
    .executeTakeFirstOrThrow();
  if (settings.version !== request.expectedVersion) throw new Refusal("stale");

  const rows = await trx
    .selectFrom("portal_reset_steps")
    .selectAll()
    .orderBy("position")
    .execute();
  checkRows(rows, request);

  const diff = computeDiff(
    rows.map((r) => ({
      id: r.id,
      featureName: r.feature_name,
      enabled: r.enabled,
      note: r.note,
      definition: r.definition,
    })),
    request.steps,
    {
      abortEmail: settings.abort_email,
      mode: PortalResetMode.parse(settings.mode),
    },
    { abortEmail: request.abortEmail, mode: request.mode },
  );
  if (!diff.hasChanges) return { version: settings.version, changed: false };

  const insertedIds = await writeSteps(trx, rows, request, diff);
  const { version } = await trx
    .updateTable("portal_reset_settings")
    .set({
      abort_email: request.abortEmail,
      mode: request.mode,
      version: sql`version + 1`,
      updated_by: adminId,
      updated_at: sql`now()`,
      ...(diff.mode === null ? {} : { mode_changed_at: sql`now()` }),
    })
    .returning("version")
    .executeTakeFirstOrThrow();
  await writeAudit(trx, request, diff, insertedIds, adminId, [
    settings.version,
    version,
  ]);
  return { version, changed: true };
}

// The checks that need the stored rows (spec 0022 Save algorithm, step 4).
function checkRows(
  rows: readonly { readonly id: string; readonly seed_key: string | null }[],
  request: SaveRequest,
): void {
  const stored = new Map(rows.map((r) => [r.id, r]));
  const ids = request.steps.flatMap((s) => (s.id === undefined ? [] : [s.id]));
  if (new Set(ids).size !== ids.length) throw new Refusal("duplicate_step");
  if (ids.some((id) => !stored.has(id))) throw new Refusal("unknown_step");

  const fileKeys = new Set(startingList().steps.map((e) => e.key));
  // A row removed in this Save gives its key back, since it is deleted first.
  const keptKeys = new Set(ids.flatMap((id) => stored.get(id)?.seed_key ?? []));
  const newKeys = request.steps.flatMap((s) => {
    if (s.seedKey === undefined) return [];
    // An existing row never changes its seed key.
    if (s.id !== undefined) throw new Refusal("bad_seed_key");
    if (!fileKeys.has(s.seedKey)) throw new Refusal("bad_seed_key");
    return [s.seedKey];
  });
  if (new Set(newKeys).size !== newKeys.length) {
    throw new Refusal("duplicate_step");
  }
  if (newKeys.some((k) => keptKeys.has(k))) throw new Refusal("duplicate_step");
}

// Delete the removed rows, move every renamed row to a temporary unique name
// (so a swap, or a rename onto a removed name, cannot hit the name index),
// then write the final values and the inserts. `position` is the index plus
// one, and its unique constraint is deferred to commit. Returns the ids of
// the new rows, in draft order.
async function writeSteps(
  trx: Transaction<DB>,
  rows: readonly {
    readonly id: string;
    readonly position: number;
    readonly feature_name: string;
  }[],
  request: SaveRequest,
  diff: SaveDiff,
): Promise<readonly string[]> {
  if (diff.removed.length > 0) {
    await trx
      .deleteFrom("portal_reset_steps")
      .where(
        "id",
        "in",
        diff.removed.map((r) => r.id),
      )
      .execute();
  }
  await Promise.all(
    diff.updated
      .filter((u) => u.changed.featureName !== undefined)
      .map((u) =>
        trx
          .updateTable("portal_reset_steps")
          .set({ feature_name: `~${u.id}` })
          .where("id", "=", u.id)
          .execute(),
      ),
  );
  const stored = new Map(rows.map((r) => [r.id, r]));
  const updatedIds = new Set(diff.updated.map((u) => u.id));
  await Promise.all(
    request.steps.flatMap((step, index) => {
      const { id } = step;
      if (id === undefined) return [];
      const moved = stored.get(id)?.position !== index + 1;
      if (!moved && !updatedIds.has(id)) return [];
      return [
        trx
          .updateTable("portal_reset_steps")
          .set({
            position: index + 1,
            feature_name: step.featureName,
            enabled: step.enabled,
            note: step.note,
            definition: JSON.stringify(step.definition),
          })
          .where("id", "=", id)
          .execute(),
      ];
    }),
  );
  const inserted = await Promise.all(
    diff.added.map(({ index }) => {
      const step = request.steps[index];
      if (!step) throw new Error(`No draft step at ${index}`);
      return trx
        .insertInto("portal_reset_steps")
        .values({
          position: index + 1,
          feature_name: step.featureName,
          enabled: step.enabled,
          note: step.note,
          definition: JSON.stringify(step.definition),
          seed_key: step.seedKey ?? null,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
    }),
  );
  return inserted.map((r) => r.id);
}

// One row per change, then one `saved` row, in the Save's own transaction
// (AC-12). The email address is never written, only that it changed.
async function writeAudit(
  trx: Transaction<DB>,
  request: SaveRequest,
  diff: SaveDiff,
  insertedIds: readonly string[],
  adminId: string,
  [from, to]: readonly [number, number],
): Promise<void> {
  const step = (
    action:
      | "portal_reset.step_added"
      | "portal_reset.step_updated"
      | "portal_reset.step_removed",
    targetId: string,
    summary: string,
    metadata: Readonly<Record<string, unknown>>,
  ) =>
    audit(trx, {
      actorUserId: adminId,
      action,
      targetType: "portal_reset_step",
      targetId,
      summary,
      metadata,
    });
  const settings = (
    action:
      | "portal_reset.steps_reordered"
      | "portal_reset.email_changed"
      | "portal_reset.mode_changed"
      | "portal_reset.saved",
    summary: string,
    metadata: Readonly<Record<string, unknown>>,
  ) =>
    audit(trx, {
      actorUserId: adminId,
      action,
      targetType: "portal_reset_settings",
      targetId: "settings",
      summary,
      metadata,
    });

  await diff.added.reduce(
    (done, { index, row }, n) =>
      done.then(() =>
        step(
          "portal_reset.step_added",
          insertedIds[n] ?? "",
          `Added step ${row.featureName} at ${index + 1}`,
          {
            featureName: row.featureName,
            position: index + 1,
            enabled: row.enabled,
            definition: row.definition,
          },
        ),
      ),
    Promise.resolve(),
  );
  for (const u of diff.updated) {
    await step("portal_reset.step_updated", u.id, u.summary, u.changed);
  }
  for (const r of diff.removed) {
    await step(
      "portal_reset.step_removed",
      r.id,
      `Removed step ${r.featureName}`,
      { featureName: r.featureName, definition: r.definition },
    );
  }
  if (diff.reordered !== null) {
    await settings(
      "portal_reset.steps_reordered",
      `Reordered ${diff.reordered.moved} steps`,
      { order: { from: diff.reordered.before, to: diff.reordered.after } },
    );
  }
  if (diff.email !== null) {
    await settings("portal_reset.email_changed", emailSummary(diff.email), {
      ...diff.email,
    });
  }
  if (diff.mode !== null) {
    await settings(
      "portal_reset.mode_changed",
      modeSummary(diff.mode.from, diff.mode.to),
      { mode: { from: diff.mode.from, to: diff.mode.to } },
    );
  }
  await settings("portal_reset.saved", `Saved, version ${from} to ${to}`, {
    version: { from, to },
    steps: request.steps.length,
  });
}
