import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AuditAction } from "./audit-actions";
import {
  AUDIT_ACTION_INFO,
  AuditArea,
  BOOKING_FORM_ACTIONS,
  actionView,
  actorKind,
  areaActions,
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
  "authentik_group.deleted": "system",
  "access.granted": "system",
  "access.revoked": "system",
  "admin.sign_in_refused": "system",
  "set_password.resent": "system",
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
