import "server-only";
import type { Kysely, Transaction } from "kysely";
import { PortalResetMode } from "@/lib/db-enums";
import { StepDefinition } from "@/lib/portal-reset/step-schema";
import type { DB } from "@/server/db/types";

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
