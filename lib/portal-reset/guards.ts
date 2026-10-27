import { z } from "zod";
import raw from "./guards.json";
import { normalizePortalRoute } from "./deny-list";
import { Rule, type Part, type StepDefinition } from "./step-schema";
import { isPortalPath } from "./portal-path";

// Items that are never deleted, whatever a saved step says (spec 0022
// AC-20). Repo data, reviewed like code: no Save input can add, remove, or
// edit a guard, and a step with no skip rule of its own is still guarded.
// The engine loads this same file (spec 0023 AC-26). Safe on both sides.
const route = z
  .string()
  .regex(/^\/api\/[A-Za-z0-9._~\-/]+$/, "A guard route is a plain /api/ path.");
const fieldPath = z.string().refine(isPortalPath);

const nested = z.strictObject({ at: fieldPath, parentIdField: fieldPath });

export const Guard = z.strictObject({
  key: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  // Plain words for the page, for example "SSIDs where ... are never deleted".
  line: z.string().min(1).max(200),
  listPath: route,
  itemsAt: fieldPath,
  nested: nested.optional(),
  idField: fieldPath,
  keepWhen: z.array(Rule).min(1).max(5),
  deleteRoutePrefix: route,
  expectKept: z.enum(["exactlyOne", "atLeastOne"]).optional(),
});
export type Guard = z.infer<typeof Guard>;

export const GuardsFile = z
  .strictObject({ guards: z.array(Guard).min(1).max(50) })
  .refine(
    (file) =>
      new Set(file.guards.map((g) => g.key)).size === file.guards.length,
    "A guard key repeats.",
  );

export const guards: readonly Guard[] = GuardsFile.parse(raw).guards;

const startsWith = (
  route: readonly string[],
  prefix: readonly string[],
): boolean => prefix.every((segment, i) => segment === route[i]);

const touches = (guard: Guard, path: string): boolean => {
  const target = normalizePortalRoute(path);
  const list = normalizePortalRoute(guard.listPath);
  return (
    (target.length === list.length && startsWith(target, list)) ||
    startsWith(target, normalizePortalRoute(guard.deleteRoutePrefix))
  );
};

// The paths a part lists from, deletes on, or writes to. A plain read is not
// a delete, so it is not guarded.
const writePaths = (part: Part): readonly string[] => {
  switch (part.kind) {
    case "delete_each":
      return [part.list.path, part.delete.path];
    case "update_record":
      return [part.list.path, part.put.path];
    case "call":
      return [part.path];
    case "read":
    case "wait":
    case "expect":
      return [];
    default: {
      const unreachable: never = part;
      throw new Error(`Unhandled part ${JSON.stringify(unreachable)}`);
    }
  }
};

// The guards that apply to a step: any whose list route or delete prefix
// one of its parts reaches. The page shows each guard's line under the step.
export const guardsForDefinition = (
  definition: StepDefinition,
  all: readonly Guard[] = guards,
): readonly Guard[] => {
  const paths = definition.parts.flatMap(writePaths);
  return all.filter((guard) => paths.some((p) => touches(guard, p)));
};
