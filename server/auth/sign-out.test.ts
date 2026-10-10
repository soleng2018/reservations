import { beforeEach, describe, expect, it, vi } from "vitest";

// Boundaries only: the users row lookup and the Authentik API.
const row = vi.hoisted(() => ({
  value: undefined as { authentik_user_pk: number | null } | undefined,
}));
const endAuthentikSessions = vi.hoisted(() => vi.fn());

vi.mock("@/server/db", () => ({
  db: () => ({
    selectFrom: () => ({
      select: () => ({
        where: () => ({ executeTakeFirst: async () => row.value }),
      }),
    }),
  }),
}));
vi.mock("@/server/authentik/client", () => ({ authentik: () => ({}) }));
vi.mock("@/server/authentik/sessions", () => ({ endAuthentikSessions }));

const { endAuthentikSessionsFor, signOutPath } = await import("./sign-out");

describe("signOutPath (AC-12)", () => {
  it("sends a learner back to the landing page", () => {
    expect(signOutPath("learner", "/l0gin", true)).toBe("/");
  });

  it("sends an admin back to the unlisted admin entry page", () => {
    expect(signOutPath("admin", "/l0gin", true)).toBe("/l0gin");
  });

  it("shows the partial sign out page when Authentik's sessions remain", () => {
    expect(signOutPath("learner", "/l0gin", false)).toBe(
      "/auth/error?reason=signout_partial",
    );
    expect(signOutPath("admin", "/l0gin", false)).toBe(
      "/auth/error?reason=signout_partial",
    );
  });
});

describe("endAuthentikSessionsFor (AC-12)", () => {
  beforeEach(() => {
    endAuthentikSessions.mockReset();
  });

  it("ends the Authentik sessions of the linked user", async () => {
    row.value = { authentik_user_pk: 42 };
    endAuthentikSessions.mockResolvedValue({ ok: true, value: 2 });

    await expect(endAuthentikSessionsFor("user-1")).resolves.toBe(true);
    expect(endAuthentikSessions).toHaveBeenCalledWith(expect.anything(), 42);
  });

  it("reports false when Authentik could not end them", async () => {
    row.value = { authentik_user_pk: 42 };
    endAuthentikSessions.mockResolvedValue({ ok: false, error: "unavailable" });

    await expect(endAuthentikSessionsFor("user-1")).resolves.toBe(false);
  });

  it("has nothing to end for a user never linked to Authentik", async () => {
    row.value = { authentik_user_pk: null };

    await expect(endAuthentikSessionsFor("user-1")).resolves.toBe(true);
    expect(endAuthentikSessions).not.toHaveBeenCalled();
  });

  it("has nothing to end when the users row is gone", async () => {
    row.value = undefined;

    await expect(endAuthentikSessionsFor("user-1")).resolves.toBe(true);
    expect(endAuthentikSessions).not.toHaveBeenCalled();
  });
});
