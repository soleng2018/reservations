import "server-only";
import { createCoreApi } from "./client";

// Test support only: a small in memory Authentik behind the real SDK,
// recording every write.

export type FakeUser = {
  pk: number;
  username: string;
  name: string;
  email: string;
  is_active: boolean;
  is_superuser: boolean;
  groups: string[];
  attributes: Record<string, unknown>;
};

export type FakeSession = { uuid: string; user: number; username: string };

// The SDK's mappers require these fields on every group.
const group = (pk: string, name: string) => ({ pk, name, roles_obj: [] });
export const ADMINS = group("admins-uuid", "hol-admins");
export const POD = group("pod-uuid", "pod-lab-1");
const PAGE = { pagination: { count: 0 } };

export function fakeAuthentik(
  initial: readonly FakeUser[],
  opts: {
    readonly down?: boolean;
    readonly sessions?: readonly FakeSession[];
  } = {},
) {
  const users = initial.map((u) => ({ ...u }));
  const sessions = (opts.sessions ?? []).map((s) => ({ ...s }));
  const writes: string[] = [];
  const groups = [ADMINS, POD, group("other-uuid", "staff")];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  const noContent = () => new Response(null, { status: 204 });

  const fetchApi = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    if (opts.down) throw new TypeError("fetch failed");
    const url = new URL(String(input));
    const path = url.pathname.replace("/api/v3", "");
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (method !== "GET") writes.push(`${method} ${path}`);
    const q = url.searchParams;

    if (method === "GET" && path === "/core/groups/")
      return json({
        ...PAGE,
        results: groups.filter(
          (g) => !q.get("name") || g.name === q.get("name"),
        ),
      });
    const byPk = path.match(/^\/core\/groups\/([^/]+)\/$/);
    if (method === "GET" && byPk)
      return json(groups.find((g) => g.pk === byPk[1]));
    if (
      method === "POST" &&
      /\/core\/groups\/[^/]+\/(add|remove)_user\/$/.test(path)
    )
      return noContent();

    if (method === "GET" && path === "/core/authenticated_sessions/")
      return json({
        ...PAGE,
        results: sessions.filter((s) => s.username === q.get("user__username")),
      });
    const session = path.match(/^\/core\/authenticated_sessions\/([^/]+)\/$/);
    if (method === "DELETE" && session) {
      const i = sessions.findIndex((s) => s.uuid === session[1]);
      if (i < 0) return json({ detail: "Not found." }, 404);
      sessions.splice(i, 1);
      return noContent();
    }

    if (method === "GET" && path === "/core/users/")
      return json({
        ...PAGE,
        results: users.filter(
          (u) =>
            (!q.get("email") || u.email === q.get("email")) &&
            (!q.get("username") || u.username === q.get("username")),
        ),
      });
    if (method === "POST" && path === "/core/users/") {
      const created = {
        ...body,
        pk: 100 + users.length,
        is_superuser: false,
        groups: [],
      };
      users.push(created);
      return json(created, 201);
    }
    const one = path.match(/^\/core\/users\/(\d+)\/(recovery\/)?$/);
    const user = one && users.find((u) => u.pk === Number(one[1]));
    if (!one || !user) return json({ detail: "Not found." }, 404);
    if (one[2])
      return json({
        link: `https://auth.test/recover/${user.pk}?for=${body?.token_duration}`,
      });
    if (method === "GET") return json(user);
    if (method === "PATCH") return json(Object.assign(user, body));
    if (method === "DELETE") return noContent();
    return json({}, 405);
  };

  return {
    users,
    sessions,
    writes,
    api: createCoreApi(
      { AUTHENTIK_URL: "https://auth.test", token: "t" },
      fetchApi,
    ),
  };
}

export const fakeUser = (over: Partial<FakeUser>): FakeUser => ({
  pk: 7,
  username: "someone",
  name: "Some One",
  email: "someone@x.test",
  is_active: true,
  is_superuser: false,
  groups: [],
  attributes: {},
  ...over,
});
