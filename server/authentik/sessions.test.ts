import { describe, expect, it } from "vitest";
import { createCoreApi } from "./client";
import { endAuthentikSessions } from "./sessions";

// A tiny Authentik with users and sessions behind the real SDK.
type Session = { uuid: string; user: number; username: string };

function fakeAuthentik(
  users: readonly { pk: number; username: string }[],
  sessions: readonly Session[],
  opts: { readonly listDown?: boolean; readonly destroyGone?: string } = {},
) {
  const live = sessions.map((s) => ({ ...s }));
  const deleted: string[] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  const fetchApi = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(String(input));
    const path = url.pathname.replace("/api/v3", "");
    const method = (init?.method ?? "GET").toUpperCase();

    const user = path.match(/^\/core\/users\/(\d+)\/$/);
    if (method === "GET" && user) {
      const found = users.find((u) => u.pk === Number(user[1]));
      return found
        ? json({ ...found, name: "", groups_obj: [], roles_obj: [] })
        : json({ detail: "Not found." }, 404);
    }
    if (method === "GET" && path === "/core/authenticated_sessions/") {
      if (opts.listDown) return json({ detail: "boom" }, 500);
      const username = url.searchParams.get("user__username");
      return json({
        pagination: { count: 0 },
        results: live
          .filter((s) => s.username === username)
          .map((s) => ({ uuid: s.uuid, user: s.user, current: false })),
      });
    }
    const one = path.match(/^\/core\/authenticated_sessions\/([^/]+)\/$/);
    if (method === "DELETE" && one) {
      if (one[1] === opts.destroyGone) return json({}, 404);
      deleted.push(one[1] ?? "");
      return new Response(null, { status: 204 });
    }
    return json({ detail: `unexpected ${method} ${path}` }, 500);
  };

  const api = createCoreApi(
    { AUTHENTIK_URL: "https://sso.test", token: "test" },
    fetchApi,
  );
  return { api, deleted };
}

const LEARNER = { pk: 7, username: "leo@example.test" };

describe("endAuthentikSessions", () => {
  // covers: AC-12
  it("ends every session of the user, on every device", async () => {
    const { api, deleted } = fakeAuthentik(
      [LEARNER],
      [
        { uuid: "a", user: 7, username: LEARNER.username },
        { uuid: "b", user: 7, username: LEARNER.username },
        { uuid: "c", user: 9, username: "other@example.test" },
      ],
    );
    expect(await endAuthentikSessions(api, 7)).toEqual({ ok: true, value: 2 });
    expect(deleted).toEqual(["a", "b"]);
  });

  it("never ends a session of another user the username filter let through", async () => {
    const { api, deleted } = fakeAuthentik(
      [LEARNER],
      [{ uuid: "x", user: 99, username: LEARNER.username }],
    );
    expect(await endAuthentikSessions(api, 7)).toEqual({ ok: true, value: 0 });
    expect(deleted).toEqual([]);
  });

  it("counts a session already gone as ended", async () => {
    const { api } = fakeAuthentik(
      [LEARNER],
      [{ uuid: "a", user: 7, username: LEARNER.username }],
      { destroyGone: "a" },
    );
    expect((await endAuthentikSessions(api, 7)).ok).toBe(true);
  });

  it("has nothing to end for a user Authentik no longer has", async () => {
    const { api } = fakeAuthentik([], []);
    expect(await endAuthentikSessions(api, 7)).toEqual({ ok: true, value: 0 });
  });

  // covers: AC-12
  it("reports unavailable when Authentik fails", async () => {
    const { api } = fakeAuthentik([LEARNER], [], { listDown: true });
    expect(await endAuthentikSessions(api, 7)).toEqual({
      ok: false,
      error: "unavailable",
    });
  });
});
