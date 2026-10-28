import "server-only";
import { isDenied, normalizePortalRoute } from "@/lib/portal-reset/deny-list";
import { guards as allGuards, type Guard } from "@/lib/portal-reset/guards";
import { classify, retryDelay } from "@/lib/portal-reset/classify";
import { routePattern } from "@/lib/portal-reset/route-pattern";
import { evaluateRules, listItems } from "@/lib/portal-reset/rules";
import { err, ok, type Result } from "@/lib/result";
import type { PortalClient, PortalRequest } from "./portal";
import { GuardStop } from "./stop";

// The hard guards (spec 0023 AC-25 to AC-27). `guards.json` says, as data,
// which records of a list are kept; this module reads each list once at the
// start of a run, remembers the ids that are kept, and refuses any `DELETE`
// or `PUT` under that list's delete route that holds one of them, whatever
// step, part, or discovered route made it. Nothing here names a kind of
// portal object, and nothing depends on a name: only the fields the guard
// file lists decide.

export type Protection = {
  readonly guard: Guard;
  // Lower case, so a differently cased id in a path still matches.
  readonly ids: ReadonlySet<string>;
};

export type Protected = readonly Protection[];

export const NO_PROTECTION: Protected = [];

export type GuardSetupError = {
  readonly guardKey: string;
  readonly why: "unreadable" | "bad_shape" | "expect_kept";
};

type Sleep = (ms: number) => Promise<void>;

// A guard's list read with the same retry policy as any list (AC-21). A list
// that is not there (404) has nothing to protect; any other failure means the
// protected ids are unknown, which stops the run before it writes.
async function readGuardList(
  portal: PortalClient,
  sleep: Sleep,
  path: string,
  attempt = 1,
): Promise<Result<unknown, "unreadable">> {
  const result = await portal.call({ method: "GET", path });
  const cls = classify(
    "list",
    result.ok
      ? { kind: "reply", status: result.value.status, message: "" }
      : { kind: result.error },
  );
  if (result.ok && cls === "done") return ok(result.value.body);
  if (cls === "nothing") return ok(undefined);
  const wait = cls === "retry" ? retryDelay(attempt) : null;
  if (wait === null) return err("unreadable");
  await sleep(wait);
  return readGuardList(portal, sleep, path, attempt + 1);
}

const keptCountOk = (guard: Guard, listed: number, kept: number): boolean => {
  if (guard.expectKept === undefined || listed === 0) return true;
  return guard.expectKept === "exactlyOne" ? kept === 1 : kept >= 1;
};

// Read every guard's list and keep the ids of the records it protects. A
// nested record also protects its parent, so the parent cannot be deleted
// with it inside. An `expectKept` mismatch (two protected SSIDs, or none while
// the list is not empty) is an error: the run ends before any write.
export async function computeProtected(
  portal: PortalClient,
  sleep: Sleep,
  guards: readonly Guard[] = allGuards,
): Promise<Result<Protected, GuardSetupError>> {
  const found: Protection[] = [];
  for (const guard of guards) {
    const body = await readGuardList(portal, sleep, guard.listPath);
    if (!body.ok) return err({ guardKey: guard.key, why: "unreadable" });
    if (body.value === undefined) {
      found.push({ guard, ids: new Set() });
      continue;
    }
    const items = listItems(body.value, guard);
    if (!items.ok) return err({ guardKey: guard.key, why: "bad_shape" });
    const kept = items.value.filter((i) =>
      evaluateRules(i.raw, guard.keepWhen),
    );
    if (!keptCountOk(guard, items.value.length, kept.length)) {
      return err({ guardKey: guard.key, why: "expect_kept" });
    }
    const ids = kept.flatMap((i) =>
      i.parentId === null ? [i.id] : [i.id, i.parentId],
    );
    found.push({ guard, ids: new Set(ids.map((id) => id.toLowerCase())) });
  }
  return ok(found);
}

const stringLeaves = (value: unknown): readonly string[] => {
  if (typeof value === "string") return [value];
  if (typeof value === "number") return [String(value)];
  if (Array.isArray(value)) return value.flatMap(stringLeaves);
  if (typeof value === "object" && value !== null) {
    return Object.values(value).flatMap(stringLeaves);
  }
  return [];
};

const underPrefix = (
  route: readonly string[],
  prefix: readonly string[],
): boolean => prefix.every((part, i) => part === route[i]);

// The guard whose delete route `path` falls under and whose protected ids the
// path (after the route prefix) or `extra` holds, or undefined.
function hitOf(
  prot: Protected,
  path: string,
  extra: readonly string[],
): Protection | undefined {
  const route = normalizePortalRoute(path);
  return prot.find(({ guard, ids }) => {
    const prefix = normalizePortalRoute(guard.deleteRoutePrefix);
    if (!underPrefix(route, prefix)) return false;
    return [
      ...route.slice(prefix.length),
      ...extra.map((e) => e.toLowerCase()),
    ].some((part) => ids.has(part));
  });
}

// The interpreter's silent skip (AC-26, D9): a protected item is never
// deleted, never recorded as a failure, never emailed. `ids` holds the ids a
// batch carries in its body.
export const isGuardedWrite =
  (prot: Protected) =>
  (method: "DELETE" | "PUT", path: string, ids: readonly string[]): boolean =>
    (method === "DELETE" || method === "PUT") &&
    hitOf(prot, path, ids) !== undefined;

// The last line of defence, in front of every call of every step and of
// discovery (AC-25, AC-26): a denied path of any method, or a write that
// holds a protected id wherever its body or path carries it, is refused with
// nothing sent and the run ends `guard_stop`. The interpreter skips protected
// items before it gets here, so reaching this refusal means a route nobody
// meant to touch the protected record.
export function guardedPortal(
  inner: PortalClient,
  prot: Protected,
): PortalClient {
  const check = (req: PortalRequest): void => {
    if (isDenied(req.path)) throw new GuardStop(routePattern(req.path));
    if (req.method !== "DELETE" && req.method !== "PUT") return;
    const hit = hitOf(prot, req.path, stringLeaves(req.body));
    if (hit !== undefined) {
      throw new GuardStop(`${hit.guard.deleteRoutePrefix}/{id}`);
    }
  };
  return {
    close: inner.close,
    call: async (req) => {
      check(req);
      return inner.call(req);
    },
  };
}
