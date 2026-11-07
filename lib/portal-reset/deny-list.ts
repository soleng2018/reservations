import { z } from "zod";
import raw from "./deny-list.json";

// Paths no step may use and the engine never calls, saved or discovered
// (spec 0022 AC-19). Identity and Users carry the sign in, so deleting one
// can lock the reset out of the portal. The file is repo data: no Save input
// can change it. Spec 0027 adds `allow`: the few method and route pairs that
// pass a deny prefix (the Users step's three calls). Safe on both sides.
const routeText = z.string().regex(/^\/[a-z0-9*/-]+$/);

const DenyListFile = z.strictObject({
  prefixes: z.array(routeText).min(1).max(50),
  allow: z
    .array(
      z.strictObject({
        method: z.enum(["GET", "POST", "PUT", "DELETE"]),
        path: routeText,
      }),
    )
    .max(20),
});

const segmentsOf = (path: string): readonly string[] =>
  path.split("/").filter((s) => s !== "");

const file = DenyListFile.parse(raw);

const prefixes: readonly (readonly string[])[] = file.prefixes.map(segmentsOf);

const allowed: readonly {
  readonly method: string;
  readonly route: readonly string[];
}[] = file.allow.map((a) => ({ method: a.method, route: segmentsOf(a.path) }));

const decodeOnce = (text: string): string => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};

// Lower case, percent decoded once, query dropped, slashes collapsed, dot
// segments resolved, each placeholder replaced by a plain segment.
export function normalizePortalRoute(path: string): readonly string[] {
  const plain = decodeOnce(path)
    .replaceAll("\\", "/")
    .replace(/\{[^}]*\}/g, "x")
    .split(/[?#]/)[0]
    .toLowerCase();
  return segmentsOf(plain).reduce<readonly string[]>((acc, segment) => {
    if (segment === ".") return acc;
    return segment === ".." ? acc.slice(0, -1) : [...acc, segment];
  }, []);
}

// Whole segments only, `*` stands for one segment, and every method is
// refused, not only writes. With a `method`, a route that an allow entry names
// (same method, same number of segments) passes; with none, no entry applies,
// so page routes and discovery stay denied (spec 0027 AC-1).
export function isDenied(path: string, method?: string): boolean {
  const route = normalizePortalRoute(path);
  const onList = prefixes.some(
    (prefix) =>
      route.length >= prefix.length &&
      prefix.every((segment, i) => segment === "*" || segment === route[i]),
  );
  if (!onList) return false;
  return !(
    method !== undefined &&
    allowed.some(
      (a) =>
        a.method === method &&
        a.route.length === route.length &&
        a.route.every((segment, i) => segment === "*" || segment === route[i]),
    )
  );
}
