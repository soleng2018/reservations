// The path language of a step (spec 0022): dot segments and [n] indexes, `$`
// for the root, nothing else (no filters, no eval). A path that resolves to
// nothing is `undefined`, never an error. Safe on both sides.
export type PathKey = string | number;

const SEGMENT = /^([A-Za-z0-9_-]*)((?:\[\d{1,4}\])*)$/;
const MAX_LENGTH = 200;
const MAX_KEYS = 12;

// The keys a path walks, or null when the text is not a valid path.
export function parsePortalPath(path: string): readonly PathKey[] | null {
  if (path.length === 0 || path.length > MAX_LENGTH) return null;
  if (!path.startsWith("$")) return parseSegments(path);
  const rest = path.slice(1);
  if (rest === "") return [];
  if (rest.startsWith(".")) return parseSegments(rest.slice(1));
  return rest.startsWith("[") ? parseSegments(rest) : null;
}

function parseSegments(text: string): readonly PathKey[] | null {
  const parsed = text.split(".").map((segment) => {
    const match = SEGMENT.exec(segment);
    if (!match || segment === "") return null;
    const name = match[1] ?? "";
    const indexes = [...(match[2] ?? "").matchAll(/\[(\d+)\]/g)].map((m) =>
      Number(m[1]),
    );
    return [...(name === "" ? [] : [name]), ...indexes];
  });
  if (parsed.some((keys) => keys === null)) return null;
  const keys = parsed.flatMap((k) => k ?? []);
  return keys.length > 0 && keys.length <= MAX_KEYS ? keys : null;
}

export const isPortalPath = (path: string): boolean =>
  parsePortalPath(path) !== null;

const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// Walk `path` through `value`. Own properties only, so `constructor` and
// `__proto__` never resolve.
export function getPortalPath(value: unknown, path: string): unknown {
  const keys = parsePortalPath(path);
  if (keys === null) return undefined;
  return keys.reduce<unknown>((current, key) => {
    if (typeof key === "number") {
      return Array.isArray(current) ? current[key] : undefined;
    }
    return isRecord(current) && Object.hasOwn(current, key)
      ? current[key]
      : undefined;
  }, value);
}

export type Scalar = string | number | boolean | null;

export const isScalar = (v: unknown): v is Scalar =>
  v === null ||
  typeof v === "string" ||
  typeof v === "number" ||
  typeof v === "boolean";

// A copy of `value` with `path` set to `next`; the input is never changed.
// Used by `update_record` to build the PUT body. A path that cannot be walked
// (a missing parent, a bad path) returns the value as it was.
export function setPortalPath(
  value: unknown,
  path: string,
  next: unknown,
): unknown {
  const keys = parsePortalPath(path);
  if (keys === null || keys.length === 0) return value;
  const put = (current: unknown, rest: readonly PathKey[]): unknown => {
    const [key, ...tail] = rest;
    if (key === undefined) return next;
    if (typeof key === "number") {
      if (!Array.isArray(current)) return current;
      return current.map((item, i) => (i === key ? put(item, tail) : item));
    }
    if (!isRecord(current)) return current;
    return { ...current, [key]: put(current[key], tail) };
  };
  return put(value, keys);
}
