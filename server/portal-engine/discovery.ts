import "server-only";
import type { Browser } from "playwright-core";
import {
  conventionRoute,
  discoveryConfig,
  dropReason,
  findList,
  isSystemRecord,
  outcomeOf,
  type Candidate,
  type Outcome,
  type RouteDetail,
} from "@/lib/portal-reset/discovery-rules";
import { isDenied } from "@/lib/portal-reset/deny-list";
import { routePattern } from "@/lib/portal-reset/route-pattern";
import { StepDefinition } from "@/lib/portal-reset/step-schema";
import {
  DISCOVERY_BUDGET,
  DISCOVERY_MAX_PAGES,
  MAX_REPLY_BYTES,
} from "@/lib/portal-reset/timing";
import { redactMessage } from "@/lib/portal-reset/redact";
import type { ResetStep } from "@/server/portal-reset/steps";
import {
  recheckStep,
  runStep,
  type ItemRecord,
  type StepEnv,
} from "./interpret";
import type { Secret } from "./secret";
import type { StorageState } from "./sign-in";

// The discovery pass (spec 0023 AC-34 to AC-38). It finds lists the saved
// steps do not cover, the way a person would: by opening the portal pages the
// steps name and seeing which lists they load. A list is acted on only when
// it is short, a GET, shown on the page by name, not a system list, not
// shared furniture, and not a parent or child of another route. The delete is
// by convention (`DELETE <list>/{id}`) through the same interpreter as every
// step, so retries, the guards, the stop check, and the dry run all apply.
// Which pages, what is furniture, what is a system flag: data (`discovery.json`,
// the steps' `pages`, `guards.json`, `deny-list.json`). No object type is
// named here (tests/portal-engine-no-types.test.ts).

// What one page showed: its text and every list its requests loaded.
export type PageCapture = {
  readonly page: string;
  readonly text: string;
  readonly lists: readonly Omit<Candidate, "page">[];
};

// `"timeout"`: the page did not settle, or the session was signed out.
export type Collector = (page: string) => Promise<PageCapture | "timeout">;

const SETTLE_MS = 30_000;
const LATE_MS = 3_000;

// A fresh browser context per page, seeded from the signed in cookies held in
// memory (AC-35): the portal caches lists between pages in one session.
export function makeBrowserCollector(
  browser: Browser,
  state: Secret<StorageState>,
  origin: string,
): Collector {
  return async (page) => {
    const context = await browser.newContext({
      storageState: state.reveal(),
      viewport: { width: 1400, height: 900 },
    });
    try {
      const tab = await context.newPage();
      const found = new Map<string, PageCapture["lists"][number]>();
      const pending: Promise<void>[] = [];
      tab.on("response", (res) => {
        const req = res.request();
        const url = new URL(res.url());
        const method = req.method();
        if (url.origin !== origin || !url.pathname.startsWith("/api/")) return;
        if (!["xhr", "fetch"].includes(req.resourceType())) return;
        if (method !== "GET" && method !== "POST") return;
        const route = routePattern(url.pathname);
        // The first good parse of a path wins: a later copy can be cut off.
        if (found.has(route)) return;
        pending.push(
          res.text().then(
            (text) => {
              if (found.has(route) || text.length > MAX_REPLY_BYTES) return;
              const list = parseJson(text);
              const hit = list === undefined ? null : findList(list);
              if (hit === null) return;
              found.set(route, {
                method,
                route,
                path: url.pathname,
                itemsAt: hit.itemsAt,
                records: hit.records,
              });
            },
            () => undefined,
          ),
        );
      });
      await tab.goto(`${origin}${page}`, {
        waitUntil: "domcontentloaded",
        timeout: SETTLE_MS,
      });
      await tab.waitForLoadState("networkidle", { timeout: SETTLE_MS });
      await tab.waitForTimeout(LATE_MS);
      // Signed out: the portal sent the page to its sign in.
      if (/authentik|idp-discovery/.test(tab.url())) return "timeout";
      await Promise.allSettled(pending);
      return {
        page,
        text: await tab.locator("body").innerText(),
        lists: [...found.values()],
      };
    } catch {
      return "timeout";
    } finally {
      await context.close().catch(() => undefined);
    }
  };
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

export type DiscoveryResult = {
  // A found route could not be cleared (a failure; the run is incomplete).
  readonly failed: boolean;
  readonly counts: Readonly<Record<string, number>>;
};

export type DiscoveryDeps = {
  readonly collect: Collector;
  readonly env: StepEnv;
  // The union of the enabled steps' `pages`, and the routes steps cover.
  readonly pages: readonly string[];
  readonly covered: readonly string[];
  // Milliseconds since discovery began (a monotonic local timer: it limits
  // this pass, it does not decide anything about a booking).
  readonly elapsedMs: () => number;
};

const LEFT = redactMessage("still there after the delete by convention");

const flagRules = discoveryConfig.systemFlagFields.map((field) => ({
  field,
  op: "ne" as const,
  value: true,
}));

// The step that deletes one found list by convention, or null when its path
// is not one a step may hold.
function conventionStep(c: Candidate): ResetStep | null {
  const labelField = c.records
    .map((r) =>
      discoveryConfig.labelFields.find((f) => typeof r[f] === "string"),
    )
    .find((f) => f !== undefined);
  const parsed = StepDefinition.safeParse({
    parts: [
      {
        kind: "delete_each",
        list: {
          method: "GET",
          path: c.path,
          itemsAt: c.itemsAt,
          idField: "id",
          ...(labelField === undefined ? {} : { labelField }),
        },
        delete: { path: `${c.path}/{id}` },
        onlyWhen: flagRules,
      },
    ],
  });
  return parsed.success
    ? {
        id: "discovery",
        position: 0,
        featureName: "Discovery",
        enabled: true,
        note: null,
        seedKey: "discovery",
        definition: parsed.data,
      }
    : null;
}

const tally = (records: readonly ItemRecord[]): Record<string, number> =>
  records.reduce<Record<string, number>>((acc, r) => {
    const key = r.status === null ? "none" : String(r.status);
    return { ...acc, [key]: (acc[key] ?? 0) + 1 };
  }, {});

const routeRecord = (
  c: Candidate,
  detail: RouteDetail,
  pass: 1 | 2,
): ItemRecord => ({
  stepKey: "discovery",
  kind: "route_found",
  label: null,
  itemId: null,
  method:
    detail.outcome === "deleted" || detail.outcome === "left"
      ? "DELETE"
      : c.method,
  route:
    detail.outcome === "deleted" || detail.outcome === "left"
      ? conventionRoute(c)
      : c.route,
  status: null,
  message: null,
  pass,
  detail,
});

type Seen = {
  readonly first: Candidate;
  readonly pages: ReadonlySet<string>;
  readonly text: string;
};

// AC-35: visit the pages, collecting the first copy of each list and the
// number of pages that loaded it.
async function collectAll(d: DiscoveryDeps): Promise<{
  seen: ReadonlyMap<string, Seen>;
  pages: number;
  timedOut: number;
}> {
  const targets = [...new Set(d.pages)]
    .filter((p) => !isDenied(p))
    .slice(0, DISCOVERY_MAX_PAGES);
  const seen = new Map<string, Seen>();
  const visit = async (
    todo: readonly string[],
    timedOut: number,
    pages: number,
  ) => {
    const [page, ...rest] = todo;
    if (page === undefined || d.elapsedMs() >= DISCOVERY_BUDGET)
      return { pages, timedOut };
    const capture = await d.collect(page);
    if (capture === "timeout") return visit(rest, timedOut + 1, pages);
    capture.lists.forEach((l) => {
      const before = seen.get(l.route);
      seen.set(l.route, {
        first: before?.first ?? { ...l, page },
        pages: new Set([...(before?.pages ?? []), page]),
        text: before?.text ?? capture.text,
      });
    });
    return visit(rest, timedOut, pages + 1);
  };
  const { pages, timedOut } = await visit(targets, 0, 0);
  return { seen, pages, timedOut };
}

export async function runDiscovery(d: DiscoveryDeps): Promise<DiscoveryResult> {
  const { seen, pages, timedOut } = await collectAll(d);
  const candidates = [...seen.entries()]
    .map(([route, s]) => ({ route, ...s }))
    .filter((s) => dropReason(s.first, s.pages.size, d.covered) === null)
    .sort((a, b) => a.route.localeCompare(b.route));
  const routes = candidates.map((c) => c.route);
  const state = { failed: false, found: 0, deleted: 0, skippedSystem: 0 };

  for (const entry of candidates) {
    const c = entry.first;
    const others = [...d.covered, ...routes.filter((r) => r !== c.route)];
    const skipped = c.records.filter((r) => isSystemRecord(r)).length;
    const outcome: Outcome = outcomeOf(c, entry.text, others);
    state.skippedSystem += skipped;
    if (outcome === "system_only") continue;
    state.found += 1;
    const base = {
      page: c.page,
      found: c.records.length,
      skipped,
      statusTally: {},
    };
    const step = outcome === "deletable" ? conventionStep(c) : null;
    if (step === null) {
      d.env.record(
        routeRecord(
          c,
          {
            ...base,
            deleted: 0,
            left: c.records.length - skipped,
            outcome: outcome === "deletable" ? "unsupported_path" : outcome,
          },
          d.env.pass,
        ),
      );
      continue;
    }
    const mine: ItemRecord[] = [];
    const env: StepEnv = {
      ...d.env,
      record: (r) => {
        mine.push(r);
        d.env.record(r);
      },
    };
    const dry = d.env.mode === "dry_run";
    const clear = async (): Promise<number> => {
      await runStep(step, env);
      if (dry) return 0;
      const left: ItemRecord[] = [];
      const clean = await recheckStep(step, {
        ...env,
        record: (r) => left.push(r),
      });
      // The final leftovers are failures; earlier ones were retried.
      return clean ? 0 : left.length;
    };
    const first = await clear();
    const deletedSoFar = () => mine.filter((r) => r.kind === "deleted").length;
    // One more try when the convention works but something is left.
    const left = first > 0 && deletedSoFar() > 0 ? await clear() : first;
    const deleted = deletedSoFar();
    if (left > 0) {
      state.failed = true;
      d.env.record({
        stepKey: "discovery",
        kind: "failed",
        label: null,
        itemId: null,
        method: "DELETE",
        route: conventionRoute(c),
        status: null,
        message: LEFT,
        pass: d.env.pass,
      });
    }
    state.deleted += deleted;
    d.env.record(
      routeRecord(
        c,
        {
          ...base,
          deleted,
          left,
          statusTally: tally(mine),
          outcome: dry ? "deletable" : left > 0 ? "left" : "deleted",
        },
        d.env.pass,
      ),
    );
  }
  return {
    failed: state.failed,
    counts: {
      discoveryPages: pages,
      discoveryTimedOut: timedOut,
      discoverySkippedSystem: state.skippedSystem,
      discoveryRoutes: state.found,
    },
  };
}
