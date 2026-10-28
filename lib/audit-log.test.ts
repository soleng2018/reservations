import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AuditAction } from "./audit-actions";
import {
  AUDIT_ACTION_INFO,
  AuditArea,
  BOOKING_FORM_ACTIONS,
  actionView,
  actionsMatchingLabel,
  actorKind,
  areaActions,
  auditHref,
  decodeCursor,
  describeMetadata,
  encodeCursor,
  escapeLike,
  hasFilters,
  parseAuditQuery,
  parseTarget,
  targetHistoryHref,
  type ActorKind,
} from "./audit-log";

describe("AUDIT_ACTION_INFO", () => {
  // covers: AC-13, every area has at least one action
  it.each(AuditArea.options)("gives the %s area at least one action", (a) => {
    expect(areaActions(a).length).toBeGreaterThan(0);
  });

  it("puts every action in exactly one area", () => {
    const all = AuditArea.options.flatMap((a) => areaActions(a));
    expect([...all].sort()).toEqual([...AuditAction.options].sort());
  });

  // covers: AC-13, the spec's own examples
  it("labels actions in sentence case from their names", () => {
    expect(AUDIT_ACTION_INFO["testbed_type.updated"].label).toBe(
      "Testbed type updated",
    );
    expect(AUDIT_ACTION_INFO["access.revoked"].label).toBe("Access revoked");
    expect(AUDIT_ACTION_INFO["admin.sign_in_refused"].label).toBe(
      "Admin sign in refused",
    );
  });

  // covers: AC-13, the area lists
  it("groups the access actions with the Authentik groups", () => {
    expect(areaActions("access_groups")).toEqual([
      "authentik_group.created",
      "authentik_group.deleted",
      "access.granted",
      "access.revoked",
      "authentik_group.released",
    ]);
    expect(areaActions("users")).toContain("set_password.resent");
    expect(areaActions("admin")).toEqual([
      "admin.signed_in",
      "admin.sign_in_refused",
      "admin.timezone_set",
    ]);
  });

  it("keeps every label unique, so a label search finds one action", () => {
    const labels = Object.values(AUDIT_ACTION_INFO).map((i) => i.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe("actionView", () => {
  it("shows a known action's label and area", () => {
    expect(actionView("api_key.secret_replaced")).toEqual({
      name: "api_key.secret_replaced",
      label: "API key secret replaced",
      area: "API keys",
    });
  });

  // covers: AC-13, a legacy action never breaks the page
  it("shows an action that no longer parses by its raw name, with no area", () => {
    expect(actionView("pod.flushed")).toEqual({
      name: "pod.flushed",
      label: "pod.flushed",
    });
  });
});

// Every action the code writes with `actorUserId: null`, and who it is.
const NULL_ACTOR: Readonly<Record<string, ActorKind>> = {
  "booking.created": "booking_form",
  "booking.refused_admin_email": "booking_form",
  "booking.refused_username_taken": "booking_form",
  "booking.refused_duplicate_email": "booking_form",
  "user.created_in_authentik": "booking_form",
  "user.tagged_in_authentik": "booking_form",
  "authentik_group.released": "system",
  "testbed.group_relinked": "system",
  "user.nile_login_set": "system",
  "user.nile_login_conflict": "system",
  "access.granted": "system",
  "portal_reset.run_finished": "system",
  "portal_reset.run_aborted": "system",
  "portal_reset.guard_stop": "system",
  "portal_reset.sign_in_failed": "system",
  "portal_reset.route_found": "system",
  "portal_reset.credential_failed": "system",
  "portal_reset.automation_user_created": "system",
  "portal_reset.report_failed": "system",
  "access.revoked": "system",
  "admin.sign_in_refused": "system",
  "set_password.resent": "system",
  "cleanup_hook.failed": "system",
  "portal_reset.seeded": "system",
};

const root = path.resolve(__dirname, "..");
const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory()
      ? sources(full)
      : /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)
        ? [full]
        : [];
  });

// The action names between each `actorUserId: null` and its `targetType`.
const nullActorActions = (): readonly string[] =>
  ["app", "server", "worker", "scripts"]
    .flatMap((d) => sources(path.join(root, d)))
    .flatMap((f) =>
      readFileSync(f, "utf8")
        .split("actorUserId: null")
        .slice(1)
        .flatMap((rest) =>
          [...rest.split("targetType")[0].matchAll(/"([a-z_]+\.[a-z_]+)"/g)]
            .map((m) => m[1])
            .filter((a) => AuditAction.safeParse(a).success),
        ),
    );

describe("actorKind", () => {
  // covers: AC-6, the code's null actor writers are exactly the listed ones
  it("knows every action the code writes with no actor", () => {
    expect([...new Set(nullActorActions())].sort()).toEqual(
      Object.keys(NULL_ACTOR).sort(),
    );
  });

  // covers: AC-6, each null actor action reads as intended
  it.each(Object.entries(NULL_ACTOR))(
    "reads a null actor %s as %s",
    (action, kind) => {
      expect(actorKind(null, action)).toBe(kind);
    },
  );

  it("lists the booking form actions as the ones the /book saga writes", () => {
    expect([...BOOKING_FORM_ACTIONS].sort()).toEqual(
      Object.entries(NULL_ACTOR)
        .filter(([, k]) => k === "booking_form")
        .map(([a]) => a)
        .sort(),
    );
  });

  it("reads a set actor by today's role, whatever the action", () => {
    expect(actorKind("admin", "booking.created")).toBe("admin");
    expect(actorKind("learner", "booking.cancelled")).toBe("learner");
  });

  // covers: AC-6, a legacy action with no actor counts as system
  it("reads an unknown action with no actor as the system", () => {
    expect(actorKind(null, "pod.flushed")).toBe("system");
  });
});

describe("targetHistoryHref", () => {
  // covers: AC-7, every target name links to its URL encoded history
  it("links to the target filter, URL encoded", () => {
    expect(targetHistoryHref("user", "authentik:12")).toBe(
      "/admin/audit-log?target=user%3Aauthentik%3A12",
    );
  });
});

const TS = "2026-10-20T13:45:01.123456Z";
const ID = "0b8f8a4e-5c1d-4f3a-9b2e-7d6c5b4a3f21";
const CURSOR = encodeCursor(TS, ID);

describe("cursor", () => {
  // covers: AC-3, the cursor round trips at microsecond precision
  it("round trips the microsecond time and the id", () => {
    expect(CURSOR).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(CURSOR)).toEqual({ ts: TS, id: ID });
  });

  // covers: AC-3, each way a cursor is bad
  it.each([
    ["not base64url", "abc$%"],
    ["undecodable", "a"],
    ["no separator", encodeCursor(TS, ID).slice(0, 10)],
    ["three parts", btoa(`${TS}|${ID}|x`).replace(/=+$/, "")],
    ["millisecond time", encodeCursor("2026-10-20T13:45:01.123Z", ID)],
    ["year zero", encodeCursor("0000-01-01T00:00:00.000000Z", ID)],
    ["bad id", encodeCursor(TS, "not-a-uuid")],
  ])("rejects a cursor that is %s", (_, raw) => {
    expect(decodeCursor(raw)).toBeUndefined();
  });
});

describe("parseTarget", () => {
  // covers: AC-5, the id rule per target type
  it.each([
    ["testbed_type:" + ID, { type: "testbed_type", id: ID }],
    ["booking:" + ID, { type: "booking", id: ID }],
    ["user:" + ID, { type: "user", id: ID }],
    ["user:authentik:12", { type: "user", id: "authentik:12" }],
    ["user:unknown", { type: "user", id: "unknown" }],
    ["authentik_group:" + ID, { type: "authentik_group", id: ID }],
    ["authentik_group:pod-abc-1", { type: "authentik_group", id: "pod-abc-1" }],
    ["portal_reset_step:" + ID, { type: "portal_reset_step", id: ID }],
    [
      "portal_reset_settings:settings",
      { type: "portal_reset_settings", id: "settings" },
    ],
  ])("reads %s", (raw, want) => {
    expect(parseTarget(raw)).toEqual(want);
  });

  it.each([
    ["no colon", "testbed"],
    ["unknown type", "pod:" + ID],
    ["non uuid testbed", "testbed:abc"],
    ["non uuid booking", "booking:authentik:12"],
    ["bad special user", "user:authentik:x"],
    ["group with a slash", "authentik_group:a/b"],
    ["group too long", "authentik_group:" + "a".repeat(65)],
    ["non uuid reset step", "portal_reset_step:abc"],
    ["reset settings with another id", "portal_reset_settings:other"],
  ])("drops a target with %s", (_, raw) => {
    expect(parseTarget(raw)).toBeUndefined();
  });
});

describe("parseAuditQuery", () => {
  // covers: AC-4, every filter read from the URL
  it("reads every filter", () => {
    expect(
      parseAuditQuery({
        actor: "booking_form",
        area: "testbeds",
        admin: ID,
        from: "2026-10-01",
        to: "2026-10-20",
        q: "  pod 7  ",
        target: "testbed:" + ID,
        learner: ID,
        before: CURSOR,
      }),
    ).toEqual({
      query: {
        actor: "booking_form",
        area: "testbeds",
        admin: ID,
        from: "2026-10-01",
        to: "2026-10-20",
        q: "pod 7",
        target: { type: "testbed", id: ID },
        learner: ID,
        cursor: { dir: "before", ts: TS, id: ID },
      },
      dropped: [],
    });
  });

  it("reads an after cursor", () => {
    expect(parseAuditQuery({ after: CURSOR }).query.cursor).toEqual({
      dir: "after",
      ts: TS,
      id: ID,
    });
  });

  // covers: AC-4, an unset GET form control is absent, not invalid
  it("treats empty values as absent", () => {
    expect(
      parseAuditQuery({ actor: "", area: "", q: "   ", from: "", to: "" }),
    ).toEqual({ query: {}, dropped: [] });
  });

  // covers: AC-4, a repeated param uses its first value
  it("uses the first of a repeated param", () => {
    expect(parseAuditQuery({ area: ["users", "bookings"] }).query.area).toBe(
      "users",
    );
  });

  // covers: AC-14, each bad param is dropped and named
  it.each([
    ["admin", { admin: "nope" }],
    ["actor", { actor: "robot" }],
    ["area", { area: "billing" }],
    ["from", { from: "2026-02-30" }],
    ["to", { to: "20-10-2026" }],
    ["q", { q: " a " }],
    ["q", { q: "x".repeat(101) }],
    ["target", { target: "testbed:abc" }],
    ["learner", { learner: "abc" }],
    ["before", { before: "forged" }],
  ])("drops a bad %s", (name, params) => {
    const { query, dropped } = parseAuditQuery(params);
    expect(query).toEqual({});
    expect(dropped).toEqual([name]);
  });

  it("keeps the good filters beside a dropped one", () => {
    expect(parseAuditQuery({ area: "users", admin: "nope" })).toEqual({
      query: { area: "users" },
      dropped: ["admin"],
    });
  });

  // covers: AC-4, AC-14, from after to drops both
  it("drops both dates when from is after to", () => {
    expect(parseAuditQuery({ from: "2026-10-21", to: "2026-10-20" })).toEqual({
      query: {},
      dropped: ["from", "to"],
    });
  });

  it("keeps one date given alone, and a single day range", () => {
    expect(parseAuditQuery({ to: "2026-10-20" }).query).toEqual({
      to: "2026-10-20",
    });
    expect(
      parseAuditQuery({ from: "2026-10-20", to: "2026-10-20" }).query,
    ).toEqual({ from: "2026-10-20", to: "2026-10-20" });
  });

  // covers: AC-14, both cursors drop both
  it("drops both cursors when both are given", () => {
    expect(parseAuditQuery({ before: CURSOR, after: CURSOR })).toEqual({
      query: {},
      dropped: ["before", "after"],
    });
  });

  it("ignores params it does not know", () => {
    expect(parseAuditQuery({ page: "2" })).toEqual({ query: {}, dropped: [] });
  });
});

describe("escapeLike", () => {
  // covers: Security model, q is matched literally
  it("escapes the ILIKE wildcards and the escape character", () => {
    expect(escapeLike("50%_off\\now")).toBe("50\\%\\_off\\\\now");
  });
});

describe("actionsMatchingLabel", () => {
  it("finds actions by label, case insensitive", () => {
    expect(actionsMatchingLabel("SECRET")).toEqual(["api_key.secret_replaced"]);
    expect(actionsMatchingLabel("no such label")).toEqual([]);
  });
});

describe("auditHref", () => {
  // covers: AC-3, AC-4, links keep the filters, never the old cursor
  it("keeps every filter and drops the query's own cursor", () => {
    const { query } = parseAuditQuery({
      area: "users",
      q: "ada lovelace",
      target: "user:authentik:12",
      before: CURSOR,
    });
    expect(auditHref(query)).toBe(
      "/admin/audit-log?area=users&q=ada+lovelace&target=user%3Aauthentik%3A12",
    );
    expect(auditHref(query, { after: "abc" })).toBe(
      "/admin/audit-log?area=users&q=ada+lovelace&target=user%3Aauthentik%3A12&after=abc",
    );
  });

  it("is the bare path with no filters", () => {
    expect(auditHref({})).toBe("/admin/audit-log");
  });

  it("round trips through parseAuditQuery", () => {
    const { query } = parseAuditQuery({
      actor: "system",
      admin: ID,
      from: "2026-10-01",
      learner: ID,
    });
    const search = new URL(auditHref(query), "http://x").searchParams;
    expect(parseAuditQuery(Object.fromEntries(search)).query).toEqual(query);
  });
});

describe("hasFilters", () => {
  it("ignores the cursor", () => {
    expect(hasFilters({ cursor: { dir: "before", ts: TS, id: ID } })).toBe(
      false,
    );
    expect(hasFilters({ learner: ID })).toBe(true);
  });
});

describe("describeMetadata", () => {
  // covers: AC-8, a changedFields edit, each key on its own line
  it("reads a from and to change per key, never merged", () => {
    expect(
      describeMetadata({
        durationValue: { from: 2, to: 3 },
        durationUnit: { from: "hours", to: "days" },
      }),
    ).toEqual([
      { label: "Duration value", text: "2 → 3" },
      { label: "Duration unit", text: "hours → days" },
    ]);
  });

  // covers: AC-8, value formats
  it("formats empty, booleans, numbers, strings, and objects", () => {
    expect(
      describeMetadata({
        company: { from: null, to: "Nile" },
        sessionsEnded: true,
        authentikSynced: false,
        authentikUserPk: 42,
        vmRevoke: "skipped",
        clients: [{ kind: "wired" }],
        extra: { a: 1 },
      }),
    ).toEqual([
      { label: "Company", text: "empty → Nile" },
      { label: "Sessions ended", text: "yes" },
      { label: "Synced to Authentik", text: "no" },
      { label: "Authentik user", text: "42" },
      { label: "Lab session revoke", text: "skipped" },
      { label: "Clients", text: '[{"kind":"wired"}]' },
      { label: "Extra", text: '{"a":1}' },
    ]);
  });

  // covers: AC-8, a key with no label reads as words in sentence case
  it("labels an unknown key from its name", () => {
    expect(describeMetadata({ googleMethod: "oauth" })).toEqual([
      { label: "Google method", text: "oauth" },
    ]);
    expect(describeMetadata({ cancelled_bookings: 2 })).toEqual([
      { label: "Cancelled bookings", text: "2" },
    ]);
  });

  it("keeps an object with more than from and to as plain JSON", () => {
    expect(describeMetadata({ x: { from: 1, to: 2, by: 3 } })).toEqual([
      { label: "X", text: '{"from":1,"to":2,"by":3}' },
    ]);
  });

  // covers: AC-8, Key invariants, secret looking keys are never shown
  it("never renders a secret looking key", () => {
    expect(
      describeMetadata({
        secret: "s",
        apiPassword: "p",
        refreshToken: "t",
        secret_ciphertext: "c",
        name: { from: "a", to: "b" },
      }),
    ).toEqual([{ label: "Name", text: "a → b" }]);
  });

  // covers: AC-8, empty metadata shows no expand button
  it("has no lines for empty or non object metadata", () => {
    expect(describeMetadata({})).toEqual([]);
    expect(describeMetadata(null)).toEqual([]);
    expect(describeMetadata([1, 2])).toEqual([]);
    expect(describeMetadata("text")).toEqual([]);
  });
});
