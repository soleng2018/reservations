import { z } from "zod";
import raw from "./deny-list.json";

// Paths no step may use and the engine never calls, saved or discovered
// (spec 0022 AC-19). Identity and Users carry the sign in, so deleting one
// can lock the reset out of the portal. The file is repo data: no Save input
// can change it. Safe on both sides.
const DenyListFile = z.strictObject({
  prefixes: z
    .array(z.string().regex(/^\/[a-z0-9*/-]+$/))
    .min(1)
    .max(50),
});

const segmentsOf = (path: string): readonly string[] =>
  path.split("/").filter((s) => s !== "");

const prefixes: readonly (readonly string[])[] =
  DenyListFile.parse(raw).prefixes.map(segmentsOf);

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
// refused, not only writes.
export function isDenied(path: string): boolean {
  const route = normalizePortalRoute(path);
  return prefixes.some(
    (prefix) =>
      route.length >= prefix.length &&
      prefix.every((segment, i) => segment === "*" || segment === route[i]),
  );
}
