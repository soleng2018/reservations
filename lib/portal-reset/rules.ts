import { err, ok, type Result } from "@/lib/result";
import { getPortalPath, isScalar, type Scalar } from "./portal-path";
import type { Cond, Part, Rule } from "./step-schema";

// The pure rules of the step language (spec 0022, spec 0023 AC-20). They take
// portal data in and give ids, labels, and booleans out; nothing here logs or
// stores a reply. Safe on both sides.
type Op = Rule["op"];
type Operand = Rule["value"];

const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const nonEmpty = (v: unknown): boolean =>
  Array.isArray(v)
    ? v.length > 0
    : typeof v === "string"
      ? v.length > 0
      : isRecord(v)
        ? Object.keys(v).length > 0
        : v !== null && v !== undefined;

export function testValue(value: unknown, op: Op, operand: Operand): boolean {
  switch (op) {
    case "eq":
      return value === operand;
    case "ne":
      return value !== operand;
    case "in":
      return Array.isArray(operand) && operand.some((o) => o === value);
    case "exists":
      return value !== undefined && value !== null;
    case "missing":
      return value === undefined || value === null;
    case "nonEmpty":
      return nonEmpty(value);
    default: {
      const never: never = op;
      throw new Error(`Unknown op ${String(never)}`);
    }
  }
}

// A list of rules is a conjunction. `field` is relative to the item.
export const evaluateRules = (item: unknown, rules: readonly Rule[]): boolean =>
  rules.every((r) => testValue(getPortalPath(item, r.field), r.op, r.value));

// Values kept by the reads of one step: read name, then key.
export type Reads = Readonly<Record<string, Readonly<Record<string, Scalar>>>>;

const readValue = (reads: Reads, read: string, key: string): unknown =>
  Object.hasOwn(reads, read) && Object.hasOwn(reads[read] ?? {}, key)
    ? reads[read]?.[key]
    : undefined;

// `when`: all conditions must hold. No `when` means the part runs.
export const evaluateConds = (
  reads: Reads,
  conds: readonly Cond[] | undefined,
): boolean =>
  (conds ?? []).every((c) =>
    testValue(readValue(reads, c.read, c.key), c.op, c.value),
  );

// What `read.pick` keeps: scalars only, by name. A pick that does not resolve
// to a scalar is left out (a missing value tests as missing).
export function pickScalars(
  body: unknown,
  pick: Readonly<Record<string, string>>,
): Readonly<Record<string, Scalar>> {
  return Object.fromEntries(
    Object.entries(pick).flatMap(([name, path]) => {
      const value = getPortalPath(body, path);
      return isScalar(value) ? [[name, value] as const] : [];
    }),
  );
}

export type ListSpec = Extract<Part, { kind: "delete_each" }>["list"];

// One listed record. `raw` stays in memory for rules; only `id`, `label`, and
// `parentId` ever leave the engine (AC-28).
export type Item = {
  readonly id: string;
  readonly label: string | null;
  readonly parentId: string | null;
  readonly raw: unknown;
};

const idText = (v: unknown): string | null =>
  typeof v === "string" && v !== ""
    ? v
    : typeof v === "number" && Number.isFinite(v)
      ? String(v)
      : null;

const labelText = (v: unknown): string | null =>
  typeof v === "string" && v !== "" ? v.slice(0, 120) : null;

// Items of a list reply, or `bad_shape` when `itemsAt` is not an array or a
// record has no usable id (AC-21).
export function listItems(
  body: unknown,
  list: Pick<
    ListSpec,
    "itemsAt" | "unwrap" | "idField" | "labelField" | "nested"
  >,
): Result<readonly Item[], "bad_shape"> {
  const top = getPortalPath(body, list.itemsAt);
  if (!Array.isArray(top)) return err("bad_shape");
  const unwrap = (r: unknown) =>
    list.unwrap === undefined ? r : getPortalPath(r, list.unwrap);
  const toItem = (record: unknown, parentId: string | null): Item | null => {
    const inner = unwrap(record);
    const id = idText(getPortalPath(inner, list.idField));
    if (id === null) return null;
    return {
      id,
      label:
        list.labelField === undefined
          ? null
          : labelText(getPortalPath(inner, list.labelField)),
      parentId,
      raw: inner,
    };
  };
  const nested = list.nested;
  const items =
    nested === undefined
      ? top.map((r) => toItem(r, null))
      : top.flatMap((parent) => {
          const parentId = idText(getPortalPath(parent, nested.parentIdField));
          const children = getPortalPath(parent, nested.at);
          if (parentId === null || !Array.isArray(children)) return [];
          return children.map((c) => toItem(c, parentId));
        });
  return items.every((i): i is Item => i !== null)
    ? ok(items)
    : err("bad_shape");
}

export type DeleteRules = {
  readonly onlyWhen?: readonly Rule[];
  readonly skipWhen?: readonly Rule[];
};

// What a `delete_each` deletes: items passing `onlyWhen`, not matching
// `skipWhen`. Guards are applied by the caller (AC-26).
export const selectForDelete = (
  items: readonly Item[],
  rules: DeleteRules,
): readonly Item[] =>
  items.filter(
    (i) =>
      (rules.onlyWhen === undefined || evaluateRules(i.raw, rules.onlyWhen)) &&
      !(rules.skipWhen !== undefined && evaluateRules(i.raw, rules.skipWhen)),
  );
