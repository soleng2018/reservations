import "server-only";
import {
  classify,
  retryDelay,
  type Class,
  type Expectations,
  type Outcome,
  type Verb,
} from "@/lib/portal-reset/classify";
import type { RouteDetail } from "@/lib/portal-reset/discovery-rules";
import { getPortalPath, setPortalPath } from "@/lib/portal-reset/portal-path";
import {
  portalMessage,
  redactMessage,
  type RedactedText,
} from "@/lib/portal-reset/redact";
import {
  evaluateConds,
  evaluateRules,
  listItems,
  pickScalars,
  selectForDelete,
  testValue,
  type Item,
  type ListSpec,
  type Reads,
} from "@/lib/portal-reset/rules";
import type { Part } from "@/lib/portal-reset/step-schema";
import { fillBody, fillPath, type Fill } from "@/lib/portal-reset/template";
import type { PortalResetRunMode } from "@/lib/db-enums";
import { ok } from "@/lib/result";
import type { ResetStep } from "@/server/portal-reset/steps";
import type { PortalClient, PortalRequest } from "./portal";

// The step interpreter (spec 0023 AC-20 to AC-23, AC-33). It takes a portal
// interface and the hooks below, so the same code runs against the real
// client and the in memory fake. A reply body goes into the pure helpers and
// is dropped: only ids, labels, picked scalars, and a redacted message leave.
//
// Empty, missing, and expected are silent (AC-22): no record, no retry. A
// failure in one item or part never stops the later ones (AC-23); the step
// is then `failed` and the run's second pass picks it up.

export type ItemKind =
  | "deleted"
  | "changed"
  | "failed"
  | "would_delete"
  | "would_change"
  | "route_found";

// What a run keeps of one item (AC-28). `route` is the pattern with its
// placeholders unfilled, never a resolved URL.
export type ItemRecord = {
  readonly stepKey: string;
  readonly kind: ItemKind;
  readonly label: string | null;
  readonly itemId: string | null;
  readonly method: PortalRequest["method"] | null;
  readonly route: string | null;
  readonly status: number | null;
  readonly message: RedactedText | null;
  readonly pass: 1 | 2;
  // For `route_found` only (AC-37): numbers and fixed words, never a record.
  readonly detail?: RouteDetail;
};

export type StepResult = "done" | "failed";

// The edges the interpreter needs from its run. `beforeWrite` is the stop
// check (AC-6): it resolves when the run may go on and throws to end it.
// `isGuarded` is the guard check (AC-26); `ids` holds the ids a batch carries
// in its body. `hidden` holds what a dry run would have deleted, so a later
// read of the same run does not list it twice (AC-33); it is per run state.
export type StepEnv = {
  readonly portal: PortalClient;
  readonly mode: PortalResetRunMode;
  readonly pass: 1 | 2;
  readonly sleep: (ms: number) => Promise<void>;
  readonly beforeWrite: () => Promise<void>;
  readonly isGuarded: (
    method: "DELETE" | "PUT",
    path: string,
    ids: readonly string[],
  ) => boolean;
  readonly record: (r: ItemRecord) => void;
  readonly hidden: Set<string>;
};

type Method = PortalRequest["method"];

export const stepKeyOf = (step: ResetStep): string => step.seedKey ?? step.id;

type Sent = {
  readonly cls: Exclude<Class, "retry">;
  readonly status: number | null;
  readonly body: unknown;
  readonly message: RedactedText;
};

const routeOf = (path: string): string => path.split("?")[0] ?? path;
const dry = (env: StepEnv) => env.mode === "dry_run";
const isWrite = (verb: Verb) => verb === "delete" || verb === "write";

// One call with the retry policy of AC-21. Never throws for a portal answer.
async function send(
  env: StepEnv,
  verb: Verb,
  req: PortalRequest,
  expect: Expectations,
  attempt = 1,
): Promise<Sent> {
  if (isWrite(verb)) await env.beforeWrite();
  const result = await env.portal.call(req);
  const outcome: Outcome = result.ok
    ? {
        kind: "reply",
        status: result.value.status,
        message: portalMessage(result.value.body),
      }
    : { kind: result.error };
  const cls = classify(verb, outcome, expect);
  const status = result.ok ? result.value.status : null;
  const body = result.ok ? result.value.body : undefined;
  const message = redactMessage(
    outcome.kind === "reply" ? outcome.message : outcome.kind,
  );
  if (cls !== "retry") return { cls, status, body, message };
  const wait = retryDelay(attempt);
  if (wait === null) return { cls: "failed", status, body, message };
  await env.sleep(wait);
  return send(env, verb, req, expect, attempt + 1);
}

type Ctx = {
  readonly env: StepEnv;
  readonly stepKey: string;
  readonly reads: Reads;
};

const fillFor = (ctx: Ctx, extra: Partial<Fill> = {}): Fill => ({
  reads: ctx.reads,
  ...extra,
});

const failed = (
  ctx: Ctx,
  f: {
    readonly item?: Item;
    readonly method: Method;
    readonly route: string;
    readonly status: number | null;
    readonly message: RedactedText | null;
  },
): void =>
  ctx.env.record({
    stepKey: ctx.stepKey,
    kind: "failed",
    label: f.item?.label ?? null,
    itemId: f.item?.id ?? null,
    method: f.method,
    route: routeOf(f.route),
    status: f.status,
    message: f.message,
    pass: ctx.env.pass,
  });

const unresolved = (ctx: Ctx, method: Method, route: string): false => {
  failed(ctx, {
    method,
    route,
    status: null,
    message: redactMessage("a placeholder had no value"),
  });
  return false;
};

// Read a list with its rules; `undefined` means nothing to do (done, silent)
// and `false` means the read failed (recorded).
async function readList(
  ctx: Ctx,
  list: ListSpec,
): Promise<readonly Item[] | false> {
  const path = fillPath(list.path, fillFor(ctx));
  const body =
    list.body === undefined ? ok(undefined) : fillBody(list.body, fillFor(ctx));
  if (!path.ok || !body.ok) return unresolved(ctx, list.method, list.path);
  const sent = await send(
    ctx.env,
    "list",
    {
      method: list.method,
      path: path.value,
      ...(body.value === undefined ? {} : { body: body.value }),
    },
    { emptyOn: list.emptyOn },
  );
  if (sent.cls === "nothing") return [];
  if (sent.cls !== "done") {
    failed(ctx, {
      method: list.method,
      route: list.path,
      status: sent.status,
      message: sent.message,
    });
    return false;
  }
  const items = listItems(sent.body, list);
  if (!items.ok) {
    failed(ctx, {
      method: list.method,
      route: list.path,
      status: sent.status,
      message: redactMessage("the list was not shaped as the step says"),
    });
    return false;
  }
  return items.value;
}

const deleteKey = (path: string, id?: string) =>
  id === undefined ? `DELETE ${path}` : `DELETE ${path}#${id}`;

async function deleteEach(
  part: Extract<Part, { kind: "delete_each" }>,
  ctx: Ctx,
): Promise<boolean> {
  const { env } = ctx;
  const items = await readList(ctx, part.list);
  if (items === false) return false;
  const batch = part.delete.batch === true;
  const expect: Expectations = {
    okStatus: part.delete.okStatus,
    expectRefusals: part.expectRefusals,
  };
  const candidates = selectForDelete(items, part).filter((item) => {
    if (batch) return !env.hidden.has(deleteKey(part.delete.path, item.id));
    const path = fillPath(
      part.delete.path,
      fillFor(ctx, { id: item.id, parentId: item.parentId }),
    );
    return !path.ok || !env.hidden.has(deleteKey(path.value));
  });

  if (batch) {
    const open = candidates.filter(
      (c) => !env.isGuarded("DELETE", part.delete.path, [c.id]),
    );
    if (open.length === 0) return true;
    const ids = open.map((c) => c.id);
    const body = fillBody(part.delete.body, fillFor(ctx, { ids }));
    if (!body.ok) return unresolved(ctx, "DELETE", part.delete.path);
    if (dry(env)) {
      open.forEach((item) => {
        env.hidden.add(deleteKey(part.delete.path, item.id));
        env.record(itemRecord(ctx, "would_delete", item, part.delete.path));
      });
      return true;
    }
    const sent = await send(
      env,
      "delete",
      { method: "DELETE", path: part.delete.path, body: body.value },
      expect,
    );
    return settle(ctx, sent, open, "DELETE", part.delete.path);
  }

  const results = [];
  for (const item of candidates) {
    const path = fillPath(
      part.delete.path,
      fillFor(ctx, { id: item.id, parentId: item.parentId }),
    );
    const body =
      part.delete.body === undefined
        ? ok(undefined)
        : fillBody(
            part.delete.body,
            fillFor(ctx, { id: item.id, parentId: item.parentId }),
          );
    if (!path.ok || !body.ok) {
      results.push(unresolved(ctx, "DELETE", part.delete.path));
      continue;
    }
    if (env.isGuarded("DELETE", path.value, [item.id])) continue;
    if (dry(env)) {
      env.hidden.add(deleteKey(path.value));
      env.record(itemRecord(ctx, "would_delete", item, part.delete.path));
      continue;
    }
    const sent = await send(
      env,
      "delete",
      {
        method: "DELETE",
        path: path.value,
        ...(body.value === undefined ? {} : { body: body.value }),
      },
      expect,
    );
    results.push(settle(ctx, sent, [item], "DELETE", part.delete.path));
  }
  return results.every(Boolean);
}

const itemRecord = (
  ctx: Ctx,
  kind: ItemKind,
  item: Item | undefined,
  route: string,
  method: Method = "DELETE",
): ItemRecord => ({
  stepKey: ctx.stepKey,
  kind,
  label: item?.label ?? null,
  itemId: item?.id ?? null,
  method,
  route: routeOf(route),
  status: null,
  message: null,
  pass: ctx.env.pass,
});

// Record the outcome of a write. Gone and expected are silent (AC-22).
function settle(
  ctx: Ctx,
  sent: Sent,
  items: readonly Item[],
  method: Method,
  route: string,
): boolean {
  if (sent.cls === "gone" || sent.cls === "expected") return true;
  if (sent.cls === "done") {
    items.forEach((item) =>
      ctx.env.record({
        ...itemRecord(
          ctx,
          method === "DELETE" ? "deleted" : "changed",
          item,
          route,
          method,
        ),
        status: sent.status,
      }),
    );
    return true;
  }
  const only = items.length === 1 ? items[0] : undefined;
  failed(ctx, {
    ...(only === undefined ? {} : { item: only }),
    method,
    route,
    status: sent.status,
    message: sent.message,
  });
  return false;
}

async function updateRecord(
  part: Extract<Part, { kind: "update_record" }>,
  ctx: Ctx,
): Promise<boolean> {
  const { env } = ctx;
  const items = await readList(ctx, part.list);
  if (items === false) return false;
  const holds = (raw: unknown) =>
    JSON.stringify(getPortalPath(raw, part.set.at)) ===
    JSON.stringify(part.set.value);
  const wanted = (item: Item) =>
    evaluateRules(item.raw, part.match) && !holds(item.raw);
  const results = [];
  for (const item of items.filter(wanted)) {
    const path = fillPath(
      part.put.path,
      fillFor(ctx, { id: item.id, parentId: item.parentId }),
    );
    if (!path.ok) {
      results.push(unresolved(ctx, "PUT", part.put.path));
      continue;
    }
    if (env.isGuarded("PUT", path.value, [item.id])) continue;
    if (dry(env)) {
      env.record(itemRecord(ctx, "would_change", item, part.put.path, "PUT"));
      continue;
    }
    // Read again just before the write, so a record that changed meanwhile,
    // or already holds the value, is left alone (AC-20).
    const again = await readList(ctx, part.list);
    if (again === false) {
      results.push(false);
      continue;
    }
    const fresh = again.find(
      (i) => i.id === item.id && i.parentId === item.parentId,
    );
    if (fresh === undefined || !wanted(fresh)) continue;
    const sent = await send(
      env,
      "write",
      {
        method: "PUT",
        path: path.value,
        body: setPortalPath(fresh.raw, part.set.at, part.set.value),
      },
      { okStatus: part.put.okStatus },
    );
    results.push(settle(ctx, sent, [fresh], "PUT", part.put.path));
  }
  return results.every(Boolean);
}

async function callPart(
  part: Extract<Part, { kind: "call" }>,
  ctx: Ctx,
): Promise<boolean> {
  const { env } = ctx;
  const path = fillPath(part.path, fillFor(ctx));
  const body =
    part.body === undefined ? ok(undefined) : fillBody(part.body, fillFor(ctx));
  if (!path.ok || !body.ok) return unresolved(ctx, part.method, part.path);
  if (env.isGuarded(part.method, path.value, [])) return true;
  if (dry(env)) {
    env.record(
      itemRecord(
        ctx,
        part.method === "DELETE" ? "would_delete" : "would_change",
        undefined,
        part.path,
        part.method,
      ),
    );
    return true;
  }
  const sent = await send(
    env,
    part.method === "DELETE" ? "delete" : "write",
    {
      method: part.method,
      path: path.value,
      ...(body.value === undefined ? {} : { body: body.value }),
    },
    { okStatus: part.okStatus, expectRefusals: part.expectRefusals },
  );
  return settle(ctx, sent, [], part.method, part.path);
}

// A read keeps only its picked scalars (AC-20). A read that finds nothing
// leaves every picked value missing, which is what `when` and `expect` test.
async function readPart(
  part: Extract<Part, { kind: "read" }>,
  ctx: Ctx,
): Promise<{ readonly ok: boolean; readonly reads: Reads }> {
  const path = fillPath(part.path, fillFor(ctx));
  const body =
    part.body === undefined ? ok(undefined) : fillBody(part.body, fillFor(ctx));
  if (!path.ok || !body.ok) {
    return { ok: unresolved(ctx, part.method, part.path), reads: ctx.reads };
  }
  const sent = await send(
    ctx.env,
    "read",
    {
      method: part.method,
      path: path.value,
      ...(body.value === undefined ? {} : { body: body.value }),
    },
    { emptyOn: part.emptyOn },
  );
  const keep = (picked: Reads[string]) => ({
    ok: true,
    reads: { ...ctx.reads, [part.as]: picked },
  });
  if (sent.cls === "nothing") return keep({});
  if (sent.cls === "done") return keep(pickScalars(sent.body, part.pick));
  failed(ctx, {
    method: part.method,
    route: part.path,
    status: sent.status,
    message: sent.message,
  });
  return { ok: false, reads: ctx.reads };
}

function checkExpect(
  part: Extract<Part, { kind: "expect" }>,
  ctx: Ctx,
): boolean {
  const held = testValue(
    Object.hasOwn(ctx.reads, part.read)
      ? ctx.reads[part.read]?.[part.key]
      : undefined,
    part.op,
    part.value,
  );
  if (!held) {
    failed(ctx, {
      method: "GET",
      route: "",
      status: null,
      message: redactMessage(
        `expected ${part.read}.${part.key} to be ${part.op}`,
      ),
    });
  }
  return held;
}

// Run the parts of one step in order. A part whose `when` does not hold is
// skipped with no record (AC-20).
export async function runStep(
  step: ResetStep,
  env: StepEnv,
): Promise<StepResult> {
  const stepKey = stepKeyOf(step);
  const outcomes: boolean[] = [];
  // Reads are the one thing a part passes to the next, so they thread through
  // the loop; everything else is per part.
  let reads: Reads = {};
  for (const part of step.definition.parts) {
    const ctx: Ctx = { env, stepKey, reads };
    if (!evaluateConds(reads, part.when)) continue;
    switch (part.kind) {
      case "read": {
        const r = await readPart(part, ctx);
        reads = r.reads;
        outcomes.push(r.ok);
        break;
      }
      case "delete_each":
        outcomes.push(await deleteEach(part, ctx));
        break;
      case "call":
        outcomes.push(await callPart(part, ctx));
        break;
      case "update_record":
        outcomes.push(await updateRecord(part, ctx));
        break;
      case "wait":
        if (!dry(env)) await env.sleep(part.seconds * 1000);
        break;
      case "expect":
        // Nothing was written in a dry run, so the check would only fail.
        if (!dry(env)) outcomes.push(checkExpect(part, ctx));
        break;
      default: {
        const unreachable: never = part;
        throw new Error(`Unhandled part ${JSON.stringify(unreachable)}`);
      }
    }
  }
  return outcomes.every(Boolean) ? "done" : "failed";
}

const LEFT = redactMessage("still there after the step");

// The delete path of one item, or null when a placeholder has no value.
const deletePathFor = (
  part: Extract<Part, { kind: "delete_each" }>,
  ctx: Ctx,
  item: Item,
): string | null => {
  if (part.delete.batch === true) return part.delete.path;
  const path = fillPath(
    part.delete.path,
    fillFor(ctx, { id: item.id, parentId: item.parentId }),
  );
  return path.ok ? path.value : null;
};

// The final re-read of a list (spec 0023 AC-19): what the step would still
// delete. A leftover is a failure, recorded with its label. `allowLeftover`
// lists (a wired device can come back) and lists with expected refusals are
// not checked.
async function leftoverDelete(
  part: Extract<Part, { kind: "delete_each" }>,
  ctx: Ctx,
): Promise<boolean> {
  const items = await readList(ctx, part.list);
  if (items === false) return false;
  // A list with expected refusals keeps the items the portal refuses on
  // purpose (AC-22), and re-reading cannot tell them from the rest.
  if (part.allowLeftover === true || part.expectRefusals !== undefined) {
    return true;
  }
  const left = selectForDelete(items, part).filter((item) => {
    const path = deletePathFor(part, ctx, item);
    return path === null || !ctx.env.isGuarded("DELETE", path, [item.id]);
  });
  left.forEach((item) =>
    failed(ctx, {
      item,
      method: "DELETE",
      route: part.delete.path,
      status: null,
      message: LEFT,
    }),
  );
  return left.length === 0;
}

// The same for `update_record`: a record that still does not hold the value.
async function leftoverUpdate(
  part: Extract<Part, { kind: "update_record" }>,
  ctx: Ctx,
): Promise<boolean> {
  const items = await readList(ctx, part.list);
  if (items === false) return false;
  const left = items.filter((item) => {
    if (!evaluateRules(item.raw, part.match)) return false;
    if (
      JSON.stringify(getPortalPath(item.raw, part.set.at)) ===
      JSON.stringify(part.set.value)
    ) {
      return false;
    }
    const path = fillPath(
      part.put.path,
      fillFor(ctx, { id: item.id, parentId: item.parentId }),
    );
    return !path.ok || !ctx.env.isGuarded("PUT", path.value, [item.id]);
  });
  left.forEach((item) =>
    failed(ctx, {
      item,
      method: "PUT",
      route: part.put.path,
      status: null,
      message: LEFT,
    }),
  );
  return left.length === 0;
}

// The final re-read of one step (spec 0023 AC-19). Reads only: it sends no
// write, so it needs no stop check. True when nothing is left.
export async function recheckStep(
  step: ResetStep,
  env: StepEnv,
): Promise<boolean> {
  const stepKey = stepKeyOf(step);
  const outcomes: boolean[] = [];
  let reads: Reads = {};
  for (const part of step.definition.parts) {
    const ctx: Ctx = { env, stepKey, reads };
    if (!evaluateConds(reads, part.when)) continue;
    switch (part.kind) {
      case "read": {
        const r = await readPart(part, ctx);
        reads = r.reads;
        outcomes.push(r.ok);
        break;
      }
      case "delete_each":
        outcomes.push(await leftoverDelete(part, ctx));
        break;
      case "update_record":
        outcomes.push(await leftoverUpdate(part, ctx));
        break;
      case "expect":
        outcomes.push(checkExpect(part, ctx));
        break;
      case "call":
      case "wait":
        break;
      default: {
        const unreachable: never = part;
        throw new Error(`Unhandled part ${JSON.stringify(unreachable)}`);
      }
    }
  }
  return outcomes.every(Boolean);
}
