import { changedFields } from "@/lib/changed-fields";
import type { PortalResetMode } from "@/lib/db-enums";
import { MODE_LABEL } from "./mode";
import { stableStringify } from "./normalize";

// The change a Save makes, computed without a database (spec 0022 AC-12). It
// compares normalized values, so a Save that differs only by spaces or key
// order is no change, and neither raises the version nor writes an audit row.
// Safe on both sides.

export type CurrentStep = {
  readonly id: string;
  readonly featureName: string;
  readonly enabled: boolean;
  readonly note: string | null;
  // As stored; it may no longer parse, so it is compared as JSON.
  readonly definition: unknown;
};

export type DraftRow = {
  readonly id?: string;
  readonly featureName: string;
  readonly enabled: boolean;
  readonly note: string | null;
  readonly definition: unknown;
};

export type Settings = {
  readonly abortEmail: string | null;
  readonly mode: PortalResetMode;
};

export type EmailChange = {
  readonly change: "set" | "cleared" | "changed";
  // The new domain, never the address.
  readonly domain: string | null;
};

export type StepUpdate = {
  readonly id: string;
  readonly featureName: string;
  readonly before: CurrentStep;
  readonly after: DraftRow;
  // { field: { from, to } } for the fields that differ, `definition` with
  // its full before and after JSON.
  readonly changed: Readonly<
    Record<string, { readonly from: unknown; readonly to: unknown }>
  >;
  readonly summary: string;
};

export type SaveDiff = {
  // `index` is the 0 based place in the draft; the position is index + 1.
  readonly added: readonly { readonly index: number; readonly row: DraftRow }[];
  readonly updated: readonly StepUpdate[];
  readonly removed: readonly CurrentStep[];
  // Surviving rows only: names before and after, when their relative order
  // changed. `moved` counts the rows that are in another place.
  readonly reordered: {
    readonly before: readonly string[];
    readonly after: readonly string[];
    readonly moved: number;
  } | null;
  readonly email: EmailChange | null;
  readonly mode: {
    readonly from: PortalResetMode;
    readonly to: PortalResetMode;
  } | null;
  readonly hasChanges: boolean;
};

const domainOf = (email: string): string =>
  email.slice(email.lastIndexOf("@") + 1);

export function emailChange(
  before: string | null,
  after: string | null,
): EmailChange | null {
  if (before === after) return null;
  if (after === null) return { change: "cleared", domain: null };
  return {
    change: before === null ? "set" : "changed",
    domain: domainOf(after),
  };
}

const sameDefinition = (a: unknown, b: unknown): boolean =>
  stableStringify(a) === stableStringify(b);

function stepUpdate(before: CurrentStep, after: DraftRow): StepUpdate | null {
  const scalar = changedFields(
    ["featureName", "enabled", "note"] as const,
    before,
    after,
  );
  const changed = sameDefinition(before.definition, after.definition)
    ? scalar
    : {
        ...scalar,
        definition: { from: before.definition, to: after.definition },
      };
  const fields = Object.keys(changed);
  if (fields.length === 0) return null;
  const only = fields.length === 1 ? fields[0] : undefined;
  const summary =
    only === "enabled"
      ? `${after.enabled ? "Enabled" : "Disabled"} step ${after.featureName}`
      : `Updated step ${after.featureName}`;
  return {
    id: before.id,
    featureName: after.featureName,
    before,
    after,
    changed,
    summary,
  };
}

export function computeDiff(
  current: readonly CurrentStep[],
  draft: readonly DraftRow[],
  before: Settings,
  after: Settings,
): SaveDiff {
  const byId = new Map(current.map((c) => [c.id, c]));
  const keptIds = new Set(
    draft.flatMap((d) => (d.id === undefined ? [] : [d.id])),
  );

  const added = draft.flatMap((row, index) =>
    row.id === undefined ? [{ index, row }] : [],
  );
  const updated = draft.flatMap((row) => {
    const was = row.id === undefined ? undefined : byId.get(row.id);
    const update = was === undefined ? null : stepUpdate(was, row);
    return update === null ? [] : [update];
  });
  const removed = current.filter((c) => !keptIds.has(c.id));

  // Survivors in their saved order against the draft order.
  const savedOrder = current.filter((c) => keptIds.has(c.id)).map((c) => c.id);
  const draftOrder = draft.flatMap((d) =>
    d.id !== undefined && byId.has(d.id) ? [d.id] : [],
  );
  const moved = draftOrder.filter((id, i) => savedOrder[i] !== id).length;
  const reordered =
    moved === 0
      ? null
      : {
          before: savedOrder.map((id) => byId.get(id)?.featureName ?? ""),
          after: draft.flatMap((d) =>
            d.id !== undefined && byId.has(d.id) ? [d.featureName] : [],
          ),
          moved,
        };

  const email = emailChange(before.abortEmail, after.abortEmail);
  const mode =
    before.mode === after.mode ? null : { from: before.mode, to: after.mode };
  return {
    added,
    updated,
    removed,
    reordered,
    email,
    mode,
    hasChanges:
      added.length + updated.length + removed.length > 0 ||
      reordered !== null ||
      email !== null ||
      mode !== null,
  };
}

// One plain sentence per change, for the audit summary column.
export const emailSummary = (change: EmailChange): string =>
  change.change === "set"
    ? "Abort email set"
    : change.change === "cleared"
      ? "Abort email cleared"
      : "Abort email changed";

export const modeSummary = (
  from: PortalResetMode,
  to: PortalResetMode,
): string =>
  `Mode changed from ${MODE_LABEL[from].toLowerCase()} to ${MODE_LABEL[to].toLowerCase()}`;
