import { z } from "zod";
import { isDenied } from "./deny-list";
import { isPortalPath } from "./portal-path";

// The step language (spec 0022): a step is a short ordered list of typed
// parts, a closed set with no free form code. One schema serves the page
// (client and server), the seed, `readResetList`, and the engine. A
// definition holds no header, no credential, and no portal data (AC-25).
// Safe on both sides.

const MAX_PARTS = 12;
const MAX_WAIT_SECONDS = 60;
const MAX_DEFINITION_BYTES = 20_000;
const MAX_PAGES = 5;
const MAX_BODY_DEPTH = 8;
const SECRET_WORDS = [
  "password",
  "token",
  "secret",
  "authorization",
  "cookie",
  "key",
];

const NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
const READ_REF = /^read\.([A-Za-z][A-Za-z0-9_]*)\.([A-Za-z][A-Za-z0-9_]*)$/;
const PLACEHOLDER =
  /^\{(id|parentId|ids|read\.[A-Za-z][A-Za-z0-9_]*\.[A-Za-z][A-Za-z0-9_]*)\}$/;
const ROUTE_CHARS = /^[A-Za-z0-9._~\-/{}$]*$/;
const QUERY_PAIR = /^[A-Za-z0-9._~-]+=(?:\{[^{}]+\}|[A-Za-z0-9._~-]*)$/;

// A key named like a secret: split into words (camel case, `_`, `-`).
export const looksSecret = (name: string): boolean =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_.-]+/)
    .some((word) => SECRET_WORDS.includes(word.toLowerCase()));

// What is wrong with a path, or null. A query is allowed only on a list or a
// read, and every `{...}` is a placeholder from the closed list, a whole
// segment (or a whole query value).
export function portalPathProblem(
  path: string,
  options: { readonly query: boolean },
): string | null {
  if (path.length > 200) return "A path is 200 characters at most.";
  if (!path.startsWith("/api/")) return "A path must start with /api/.";
  if (path.includes("..")) return "A path cannot hold ..";
  if (path.includes("//")) return "A path cannot hold //.";
  if (path.includes("#")) return "A path cannot hold #.";
  if (/\s/.test(path)) return "A path cannot hold a space.";
  const queryAt = path.indexOf("?");
  const route = queryAt === -1 ? path : path.slice(0, queryAt);
  const query = queryAt === -1 ? null : path.slice(queryAt + 1);
  if (!ROUTE_CHARS.test(route)) return "A path holds a character not allowed.";
  if (query !== null) {
    if (!options.query) return "Only a list or a read may have a query.";
    if (!query.split("&").every((pair) => QUERY_PAIR.test(pair))) {
      return "A query is name=value pairs joined by &.";
    }
  }
  const badSegment = route
    .split("/")
    .find((s) => /[{}]/.test(s) && !PLACEHOLDER.test(s));
  if (badSegment !== undefined) {
    return `${badSegment} is not a placeholder. Use {id}, {parentId}, {ids}, or {read.NAME.KEY}, as a whole segment.`;
  }
  if (isDenied(path)) {
    return "This path is on the deny list (Identity and Users are never called).";
  }
  return null;
}

const portalPath = (options: { readonly query: boolean }) =>
  z.string().superRefine((path, ctx) => {
    const problem = portalPathProblem(path, options);
    if (problem !== null) ctx.addIssue({ code: "custom", message: problem });
  });

const pageRoute = z
  .string()
  .max(200)
  .superRefine((route, ctx) => {
    const problem = !route.startsWith("/")
      ? "A page route must start with /."
      : route.startsWith("/api")
        ? "A page route is not an API path."
        : !/^[A-Za-z0-9_\-/]+$/.test(route) || route.includes("//")
          ? "A page route holds only letters, digits, - _ and /."
          : isDenied(route)
            ? "This page is on the deny list (Identity and Users are never visited)."
            : null;
    if (problem !== null) ctx.addIssue({ code: "custom", message: problem });
  });

// A field path inside an item or a reply (dots and [n] only).
const fieldPath = z
  .string()
  .refine(isPortalPath, "Not a valid field path (dots and [0] indexes only).");

const name = z
  .string()
  .max(40)
  .regex(NAME, "A name is letters, digits and _, starting with a letter.");

const scalar = z.union([
  z.string().max(200),
  z.number(),
  z.boolean(),
  z.null(),
]);

const OPS = ["eq", "ne", "in", "exists", "missing", "nonEmpty"] as const;
const op = z.enum(OPS);
type Op = (typeof OPS)[number];

function checkOperand(
  value: unknown,
  operator: Op,
  ctx: z.RefinementCtx,
): void {
  const problem =
    operator === "eq" || operator === "ne"
      ? value === undefined
        ? `"${operator}" needs a value.`
        : Array.isArray(value)
          ? `"${operator}" takes one value, not a list.`
          : null
      : operator === "in"
        ? Array.isArray(value)
          ? null
          : `"in" needs a list of values.`
        : value === undefined
          ? null
          : `"${operator}" takes no value.`;
  if (problem !== null) {
    ctx.addIssue({ code: "custom", message: problem, path: ["value"] });
  }
}

const operand = z.union([scalar, z.array(scalar).max(50)]);

// A test on a field of one item: `field` is relative to the item. A list of
// rules is a conjunction.
const rule = z
  .strictObject({ field: fieldPath, op, value: operand.optional() })
  .superRefine((r, ctx) => checkOperand(r.value, r.op, ctx));
export const Rule = rule;
export type Rule = z.infer<typeof rule>;

// A test on a value kept by an earlier read of the same step.
const cond = z
  .strictObject({ read: name, key: name, op, value: operand.optional() })
  .superRefine((c, ctx) => checkOperand(c.value, c.op, ctx));
export const Cond = cond;
export type Cond = z.infer<typeof cond>;

// A body template: literals and whole string placeholders only. No key may
// be named like a secret.
const body = z.json().superRefine((value, ctx) => {
  const visit = (
    v: unknown,
    at: readonly (string | number)[],
    depth: number,
  ) => {
    if (depth > MAX_BODY_DEPTH) {
      ctx.addIssue({
        code: "custom",
        message: "A body is nested too deep.",
        path: [...at],
      });
      return;
    }
    if (typeof v === "string") {
      if (/[{}]/.test(v) && !PLACEHOLDER.test(v)) {
        ctx.addIssue({
          code: "custom",
          message: `"${v}" is not a placeholder. A placeholder is a whole value: {id}, {parentId}, {ids}, or {read.NAME.KEY}.`,
          path: [...at],
        });
      }
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((item, i) => visit(item, [...at, i], depth + 1));
      return;
    }
    if (typeof v === "object" && v !== null) {
      Object.entries(v).forEach(([key, item]) => {
        if (looksSecret(key)) {
          ctx.addIssue({
            code: "custom",
            message: `A body cannot hold a key named like a secret (${key}).`,
            path: [...at, key],
          });
        }
        visit(item, [...at, key], depth + 1);
      });
    }
  };
  visit(value, [], 0);
});

const statusList = z.array(z.number().int().min(100).max(599)).min(1).max(10);

const expectRefusal = z.strictObject({
  status: z.number().int().min(400).max(599),
  messageContains: z.string().min(1).max(200),
});

const when = z.array(cond).min(1).max(5).optional();

const nested = z.strictObject({ at: fieldPath, parentIdField: fieldPath });

const list = z.strictObject({
  method: z.enum(["GET", "POST"]),
  path: portalPath({ query: true }),
  body: body.optional(),
  itemsAt: fieldPath,
  nested: nested.optional(),
  unwrap: fieldPath.optional(),
  idField: fieldPath,
  labelField: fieldPath.optional(),
  emptyOn: statusList.optional(),
});

const deleteCall = z.strictObject({
  path: portalPath({ query: false }),
  body: body.optional(),
  batch: z.boolean().optional(),
  okStatus: statusList.optional(),
});

const readPart = z.strictObject({
  kind: z.literal("read"),
  as: name,
  method: z.enum(["GET", "POST"]),
  path: portalPath({ query: true }),
  body: body.optional(),
  // Name to path. Each must resolve to a scalar; the reply is dropped.
  pick: z
    .record(name, fieldPath)
    .refine((p) => Object.keys(p).length >= 1, "Pick at least one field.")
    .refine((p) => Object.keys(p).length <= 20, "Pick 20 fields at most."),
  emptyOn: statusList.optional(),
  when,
});

const deleteEachPart = z.strictObject({
  kind: z.literal("delete_each"),
  list,
  delete: deleteCall,
  skipWhen: z.array(rule).min(1).max(10).optional(),
  onlyWhen: z.array(rule).min(1).max(10).optional(),
  expectRefusals: z.array(expectRefusal).min(1).max(5).optional(),
  allowLeftover: z.boolean().optional(),
  when,
});

const callPart = z.strictObject({
  kind: z.literal("call"),
  method: z.enum(["DELETE", "PUT"]),
  path: portalPath({ query: false }),
  body: body.optional(),
  okStatus: statusList.optional(),
  expectRefusals: z.array(expectRefusal).min(1).max(5).optional(),
  when,
});

const updateRecordPart = z.strictObject({
  kind: z.literal("update_record"),
  list,
  match: z.array(rule).min(1).max(10),
  set: z.strictObject({ at: fieldPath, value: body }),
  put: z.strictObject({
    path: portalPath({ query: false }),
    okStatus: statusList.optional(),
  }),
  when,
});

const waitPart = z.strictObject({
  kind: z.literal("wait"),
  seconds: z.number().int().min(1).max(MAX_WAIT_SECONDS),
  when,
});

const expectPart = z
  .strictObject({
    kind: z.literal("expect"),
    read: name,
    key: name,
    op,
    value: operand.optional(),
    when,
  })
  .superRefine((e, ctx) => checkOperand(e.value, e.op, ctx));

const part = z.discriminatedUnion("kind", [
  readPart,
  deleteEachPart,
  callPart,
  updateRecordPart,
  waitPart,
  expectPart,
]);
export type Part = z.infer<typeof part>;

// --- Placeholders must be supplied where they are used (AC-9) ---

type Reads = ReadonlyMap<string, ReadonlySet<string>>;
type Allowed = {
  readonly item: boolean;
  readonly parent: boolean;
  readonly ids: boolean;
};

const NONE: Allowed = { item: false, parent: false, ids: false };

const placeholdersIn = (value: unknown): readonly string[] =>
  typeof value === "string"
    ? [...value.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1] ?? "")
    : Array.isArray(value)
      ? value.flatMap(placeholdersIn)
      : typeof value === "object" && value !== null
        ? Object.values(value).flatMap(placeholdersIn)
        : [];

const hasPlaceholder = (value: unknown, which: string): boolean =>
  placeholdersIn(value).includes(which);

function readRefProblem(
  reads: Reads,
  readName: string,
  key: string,
): string | null {
  const keys = reads.get(readName);
  if (keys === undefined) {
    return `No read named "${readName}" comes earlier in this step.`;
  }
  return keys.has(key) ? null : `Read "${readName}" does not pick "${key}".`;
}

function checkPlaceholders(
  value: unknown,
  allowed: Allowed,
  reads: Reads,
  at: readonly (string | number)[],
  ctx: z.RefinementCtx,
): void {
  const add = (message: string) =>
    ctx.addIssue({ code: "custom", message, path: [...at] });
  placeholdersIn(value).forEach((p) => {
    if (p === "id" && !allowed.item)
      add("{id} is only for a delete of each item.");
    else if (p === "parentId" && !allowed.parent) {
      add("{parentId} needs nested.parentIdField on the list.");
    } else if (p === "ids" && !allowed.ids) {
      add("{ids} is only for a batch delete.");
    } else {
      const ref = READ_REF.exec(p);
      if (ref) {
        const problem = readRefProblem(reads, ref[1] ?? "", ref[2] ?? "");
        if (problem !== null) add(problem);
      }
    }
  });
}

function checkConds(
  conds: readonly { readonly read: string; readonly key: string }[],
  reads: Reads,
  at: readonly (string | number)[],
  ctx: z.RefinementCtx,
): void {
  conds.forEach((c, j) => {
    const problem = readRefProblem(reads, c.read, c.key);
    if (problem !== null) {
      ctx.addIssue({
        code: "custom",
        message: problem,
        path: [...at, j, reads.has(c.read) ? "key" : "read"],
      });
    }
  });
}

function checkPart(
  p: Part,
  i: number,
  reads: Reads,
  ctx: z.RefinementCtx,
): void {
  const at = ["parts", i] as const;
  checkConds(p.when ?? [], reads, [...at, "when"], ctx);
  switch (p.kind) {
    case "read":
      checkPlaceholders(p.path, NONE, reads, [...at, "path"], ctx);
      checkPlaceholders(p.body, NONE, reads, [...at, "body"], ctx);
      return;
    case "wait":
      return;
    case "expect": {
      const problem = readRefProblem(reads, p.read, p.key);
      if (problem !== null) {
        ctx.addIssue({
          code: "custom",
          message: problem,
          path: [...at, reads.has(p.read) ? "key" : "read"],
        });
      }
      return;
    }
    case "call":
      checkPlaceholders(p.path, NONE, reads, [...at, "path"], ctx);
      checkPlaceholders(p.body, NONE, reads, [...at, "body"], ctx);
      return;
    case "update_record": {
      checkListPlaceholders(p.list, reads, [...at, "list"], ctx);
      const allowed = {
        ...NONE,
        item: true,
        parent: p.list.nested !== undefined,
      };
      checkPlaceholders(
        p.put.path,
        allowed,
        reads,
        [...at, "put", "path"],
        ctx,
      );
      checkPlaceholders(p.set.value, NONE, reads, [...at, "set", "value"], ctx);
      return;
    }
    case "delete_each": {
      checkListPlaceholders(p.list, reads, [...at, "list"], ctx);
      const batch = p.delete.batch === true;
      const allowed = {
        item: !batch,
        parent: p.list.nested !== undefined,
        ids: batch,
      };
      checkPlaceholders(
        p.delete.path,
        allowed,
        reads,
        [...at, "delete", "path"],
        ctx,
      );
      checkPlaceholders(
        p.delete.body,
        allowed,
        reads,
        [...at, "delete", "body"],
        ctx,
      );
      if (batch && !hasPlaceholder(p.delete.body, "ids")) {
        ctx.addIssue({
          code: "custom",
          message: "A batch delete sends {ids} in its body.",
          path: [...at, "delete", "body"],
        });
      }
      if (
        !batch &&
        !hasPlaceholder(p.delete.path, "id") &&
        !hasPlaceholder(p.delete.body, "id")
      ) {
        ctx.addIssue({
          code: "custom",
          message: "A delete of each item names the item with {id}.",
          path: [...at, "delete", "path"],
        });
      }
      return;
    }
    default: {
      const unreachable: never = p;
      throw new Error(`Unhandled part ${JSON.stringify(unreachable)}`);
    }
  }
}

function checkListPlaceholders(
  l: z.infer<typeof list>,
  reads: Reads,
  at: readonly (string | number)[],
  ctx: z.RefinementCtx,
): void {
  checkPlaceholders(l.path, NONE, reads, [...at, "path"], ctx);
  checkPlaceholders(l.body, NONE, reads, [...at, "body"], ctx);
}

const pickedKeys = (p: Part): ReadonlySet<string> =>
  p.kind === "read" ? new Set(Object.keys(p.pick)) : new Set();

// The size Postgres checks is `octet_length(definition::text)`, and jsonb
// text has a space after every `:` and `,`, so measure that form, in bytes.
export function jsonbTextBytes(value: unknown): number {
  const text = (v: unknown): string =>
    Array.isArray(v)
      ? `[${v.map(text).join(", ")}]`
      : typeof v === "object" && v !== null
        ? `{${Object.entries(v)
            .filter(([, item]) => item !== undefined)
            .map(([k, item]) => `${JSON.stringify(k)}: ${text(item)}`)
            .join(", ")}}`
        : (JSON.stringify(v) ?? "null");
  return new TextEncoder().encode(text(value)).length;
}

const stepDefinition = z
  .strictObject({
    parts: z.array(part).min(1).max(MAX_PARTS),
    pages: z.array(pageRoute).max(MAX_PAGES).optional(),
  })
  .superRefine((def, ctx) => {
    // Reads known so far, in step order: a part sees only earlier reads.
    def.parts.reduce<Reads>((reads, p, i) => {
      checkPart(p, i, reads, ctx);
      if (p.kind !== "read") return reads;
      if (reads.has(p.as)) {
        ctx.addIssue({
          code: "custom",
          message: `A read named "${p.as}" already exists in this step.`,
          path: ["parts", i, "as"],
        });
      }
      Object.keys(p.pick)
        .filter(looksSecret)
        .forEach((key) =>
          ctx.addIssue({
            code: "custom",
            message: `A picked name cannot look like a secret (${key}).`,
            path: ["parts", i, "pick", key],
          }),
        );
      return new Map([...reads, [p.as, pickedKeys(p)]]);
    }, new Map());
    const totalWait = def.parts.reduce(
      (sum, p) => sum + (p.kind === "wait" ? p.seconds : 0),
      0,
    );
    if (totalWait > MAX_WAIT_SECONDS) {
      ctx.addIssue({
        code: "custom",
        message: `A step waits ${MAX_WAIT_SECONDS} seconds in total at most.`,
        path: ["parts"],
      });
    }
    if (jsonbTextBytes(def) > MAX_DEFINITION_BYTES) {
      ctx.addIssue({
        code: "custom",
        message: "A definition is 20 000 characters at most.",
        path: ["parts"],
      });
    }
  });

export const StepDefinition = stepDefinition;
export type StepDefinition = z.infer<typeof stepDefinition>;
export const MAX_STEPS = 100;
