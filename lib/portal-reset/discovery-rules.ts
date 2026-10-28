import { z } from "zod";
import raw from "./discovery.json";
import { isDenied } from "./deny-list";
import { getPortalPath } from "./portal-path";
import { routePattern } from "./route-pattern";
import type { StepDefinition } from "./step-schema";

// The pure rules of the discovery pass (spec 0023 AC-34 to AC-37). Discovery
// finds lists the saved steps do not cover. Everything that names a portal
// object type is data in `discovery.json`, `guards.json`, and
// `deny-list.json`; this file holds only the algorithm. Safe on both sides.

const Config = z.strictObject({
  furniture: z.array(z.string().min(1).max(100)).max(100),
  exclude: z.array(z.string().max(200)).max(100),
  listShapes: z.array(z.string().max(100)).min(1).max(10),
  labelFields: z.array(z.string().min(1).max(50)).min(1).max(10),
  systemFlagFields: z.array(z.string().min(1).max(50)).max(20),
  sharedThreshold: z.number().int().min(2).max(10),
  maxItemsPerRoute: z.number().int().min(1).max(100),
});
export type DiscoveryConfig = z.infer<typeof Config>;

export const discoveryConfig: DiscoveryConfig = Config.parse(raw);

type Rec = Readonly<Record<string, unknown>>;

const isRec = (v: unknown): v is Rec =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const hasId = (r: Rec): boolean =>
  (typeof r.id === "string" && r.id !== "") ||
  (typeof r.id === "number" && Number.isFinite(r.id));

// An array of records that each have an `id`, found at one of the shapes.
// The first shape that gives one wins. An empty array is not a list we can
// learn anything from, so it is `null` too.
export type FoundList = {
  // Where the records sit, as a step path (`$` is the root).
  readonly itemsAt: string;
  readonly records: readonly Rec[];
};

export function findList(
  body: unknown,
  cfg: DiscoveryConfig = discoveryConfig,
): FoundList | null {
  for (const shape of cfg.listShapes) {
    const at = shape === "" ? body : getPortalPath(body, shape);
    if (Array.isArray(at) && at.length > 0 && at.every(isRec)) {
      const records: readonly Rec[] = at.filter(isRec);
      if (records.every(hasId))
        return { itemsAt: shape === "" ? "$" : shape, records };
    }
  }
  return null;
}

export const listRecords = (
  body: unknown,
  cfg: DiscoveryConfig = discoveryConfig,
): readonly Rec[] | null => findList(body, cfg)?.records ?? null;

const placeholders = (path: string): string =>
  (path.split(/[?#]/)[0] ?? path).replace(/\{[^}]*\}/g, "{id}");

// The routes the saved steps already work on: every list path and every
// delete or write route, as patterns.
export function coveredRoutes(
  definitions: readonly StepDefinition[],
): readonly string[] {
  const paths = definitions.flatMap((d) =>
    d.parts.flatMap((p): readonly string[] => {
      switch (p.kind) {
        case "read":
        case "call":
          return [p.path];
        case "delete_each":
          return [p.list.path, p.delete.path];
        case "update_record":
          return [p.list.path, p.put.path];
        case "wait":
        case "expect":
          return [];
        default: {
          const never: never = p;
          throw new Error(`Unknown part ${JSON.stringify(never)}`);
        }
      }
    }),
  );
  return [...new Set(paths.map((p) => routePattern(placeholders(p))))];
}

const segmentsOf = (route: string): readonly string[] =>
  route.split("/").filter((s) => s !== "");

// `a` is `b` or sits under it, by whole segments.
const startsWith = (a: string, b: string): boolean => {
  const x = segmentsOf(a);
  const y = segmentsOf(b);
  return y.length <= x.length && y.every((s, i) => s === x[i]);
};

// A route a step already covers: equal to one of its routes, or under one.
export const isCovered = (route: string, covered: readonly string[]): boolean =>
  covered.some((c) => startsWith(route, c));

// Two routes where one is a segment prefix of the other. Not for deleting by
// convention: the pair may be a parent and its children.
export const isRelated = (a: string, b: string): boolean =>
  a !== b && (startsWith(a, b) || startsWith(b, a));

export type Candidate = {
  readonly method: "GET" | "POST";
  // The route pattern with `{id}`, and the path as called (no query).
  readonly route: string;
  readonly path: string;
  readonly page: string;
  readonly itemsAt: string;
  readonly records: readonly Rec[];
};

const furnitureRes = discoveryConfig.furniture.map((f) => new RegExp(f, "i"));

export type DropReason =
  "furniture" | "denied" | "shared" | "excluded" | "covered";

// AC-36: why a candidate is not looked at, or null when it stays. A denied
// route is silent (the portal reads Identity on its own pages).
export function dropReason(
  c: Candidate,
  pageCount: number,
  covered: readonly string[],
  cfg: DiscoveryConfig = discoveryConfig,
): DropReason | null {
  if (isDenied(c.path)) return "denied";
  if (furnitureRes.some((re) => re.test(c.route))) return "furniture";
  if (pageCount >= cfg.sharedThreshold) return "shared";
  if (cfg.exclude.includes(c.route)) return "excluded";
  return isCovered(c.route, covered) ? "covered" : null;
}

// What discovery reports for one route (the `detail.outcome` word).
export type Outcome =
  | "related"
  | "post_list"
  | "over_cap"
  | "uncorrelated"
  | "system_only"
  | "deletable";

// What is written to a `route_found` record (numbers and fixed words only).
export type RouteDetail = {
  readonly page: string;
  readonly found: number;
  readonly deleted: number;
  readonly skipped: number;
  readonly left: number;
  readonly statusTally: Readonly<Record<string, number>>;
  readonly outcome: Outcome | "deleted" | "left" | "unsupported_path";
};

export const labelOf = (
  r: Rec,
  cfg: DiscoveryConfig = discoveryConfig,
): string | null => {
  for (const field of cfg.labelFields) {
    const v = r[field];
    if (typeof v === "string" && v.trim().length >= 2) return v.trim();
  }
  return null;
};

// AC-37: a record is presumed a system item when any flag field is true.
export const isSystemRecord = (
  r: Rec,
  cfg: DiscoveryConfig = discoveryConfig,
): boolean => cfg.systemFlagFields.some((f) => getPortalPath(r, f) === true);

// AC-37: at least one record's label shows in the page's visible text, so the
// list is what the page shows and not some other data that merely has ids.
export const correlates = (
  records: readonly Rec[],
  pageText: string,
  cfg: DiscoveryConfig = discoveryConfig,
): boolean => {
  const text = pageText.toLowerCase();
  return records.some((r) => {
    const label = labelOf(r, cfg);
    return label !== null && text.includes(label.toLowerCase());
  });
};

export const recordId = (r: Rec): string =>
  typeof r.id === "number" ? String(r.id) : String(r.id);

// AC-37: the route by convention for one record.
export const conventionPath = (c: Candidate, id: string): string =>
  `${c.path}/${encodeURIComponent(id)}`;
export const conventionRoute = (c: Candidate): string => `${c.route}/{id}`;

// AC-36, AC-37: sort what stays into what is acted on and what is only
// reported. `pageText` is the text of the page the candidate came from.
export function outcomeOf(
  c: Candidate,
  pageText: string,
  others: readonly string[],
  cfg: DiscoveryConfig = discoveryConfig,
): Outcome {
  if (others.some((o) => isRelated(c.route, o))) return "related";
  if (c.method !== "GET") return "post_list";
  if (c.records.length > cfg.maxItemsPerRoute) return "over_cap";
  if (!correlates(c.records, pageText, cfg)) return "uncorrelated";
  return c.records.every((r) => isSystemRecord(r, cfg))
    ? "system_only"
    : "deletable";
}
