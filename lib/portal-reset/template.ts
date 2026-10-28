import { err, ok, type Result } from "@/lib/result";
import type { Reads } from "./rules";

// Placeholders in paths and bodies (spec 0022): `{id}`, `{parentId}`, `{ids}`,
// `{read.NAME.KEY}`, only as whole body strings. An id is URL encoded in a
// path and left as is in a body. Safe on both sides.
export type Fill = {
  readonly id?: string;
  readonly parentId?: string | null;
  readonly ids?: readonly string[];
  readonly reads: Reads;
};

const TOKEN = /\{([^{}]+)\}/g;
const WHOLE = /^\{([^{}]+)\}$/;

function lookup(token: string, fill: Fill): unknown {
  if (token === "id") return fill.id;
  if (token === "parentId") return fill.parentId ?? undefined;
  if (token === "ids") return fill.ids;
  const ref = /^read\.([^.]+)\.([^.]+)$/.exec(token);
  if (!ref) return undefined;
  const [, read = "", key = ""] = ref;
  return Object.hasOwn(fill.reads, read) &&
    Object.hasOwn(fill.reads[read] ?? {}, key)
    ? fill.reads[read]?.[key]
    : undefined;
}

// A path with every placeholder filled, or `unresolved` when a value is
// missing (the part is then a failure, never a call to a half filled path).
export function fillPath(
  path: string,
  fill: Fill,
): Result<string, "unresolved"> {
  const missing = [...path.matchAll(TOKEN)].some((m) => {
    const v = lookup(m[1] ?? "", fill);
    return v === undefined || v === null || Array.isArray(v);
  });
  if (missing) return err("unresolved");
  return ok(
    path.replace(TOKEN, (_, token: string) =>
      encodeURIComponent(String(lookup(token, fill))),
    ),
  );
}

// A body with every whole string placeholder replaced by its value.
export function fillBody(
  body: unknown,
  fill: Fill,
): Result<unknown, "unresolved"> {
  if (typeof body === "string") {
    const whole = WHOLE.exec(body);
    if (!whole) return ok(body);
    const v = lookup(whole[1] ?? "", fill);
    return v === undefined ? err("unresolved") : ok(v);
  }
  if (Array.isArray(body)) {
    const parts = body.map((b) => fillBody(b, fill));
    const bad = parts.find((p) => !p.ok);
    return bad ?? ok(parts.map((p) => (p.ok ? p.value : undefined)));
  }
  if (typeof body === "object" && body !== null) {
    const entries = Object.entries(body).map(
      ([k, v]) => [k, fillBody(v, fill)] as const,
    );
    const bad = entries.find(([, r]) => !r.ok);
    return bad
      ? bad[1]
      : ok(
          Object.fromEntries(
            entries.map(([k, r]) => [k, r.ok ? r.value : undefined]),
          ),
        );
  }
  return ok(body);
}
