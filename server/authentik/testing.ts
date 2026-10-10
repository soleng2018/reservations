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

export type FakeGroup = {
  pk: string;
  name: string;
  attributes: Record<string, unknown>;
  // The SDK's mappers require this field on every group.
  roles_obj: never[];
};

export const fakeGroup = (
  pk: string,
  name: string,
  attributes: Record<string, unknown> = {},
): FakeGroup => ({ pk, name, attributes, roles_obj: [] });

export const ADMINS = fakeGroup("admins-uuid", "hol-admins");
export const POD = fakeGroup("pod-uuid", "pod-lab-1");

export function fakeAuthentik(
  initial: readonly FakeUser[],
  opts: {
    readonly down?: boolean;
    readonly sessions?: readonly FakeSession[];
    readonly groups?: readonly FakeGroup[];
    // Answer 500 to the matching requests, e.g. one group's reads.
    readonly fail?: (method: string, path: string) => boolean;
  } = {},
) {
  const users = initial.map((u) => ({ ...u, groups: [...u.groups] }));
  const sessions = (opts.sessions ?? []).map((s) => ({ ...s }));
  const writes: string[] = [];
  const groups = [ADMINS, POD, fakeGroup("other-uuid", "staff")]
    .concat(opts.groups ?? [])
    .map((g) => ({ ...g, attributes: { ...g.attributes } }));
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  const noContent = () => new Response(null, { status: 204 });
  const notFound = () => json({ detail: "Not found." }, 404);
  const page = <T>(all: readonly T[], q: URLSearchParams) => {
    const size = Number(q.get("page_size") ?? 100);
    const n = Number(q.get("page") ?? 1);
    const more = all.length > n * size;
    return {
      pagination: { count: all.length, current: n, next: more ? n + 1 : 0 },
      results: all.slice((n - 1) * size, n * size),
    };
  };

  const fetchApi = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    if (opts.down) throw new TypeError("fetch failed");
    const url = new URL(String(input));
    const path = url.pathname.replace("/api/v3", "");
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (opts.fail?.(method, path)) return json({ detail: "boom" }, 500);
    if (method !== "GET") writes.push(`${method} ${path}`);
    const q = url.searchParams;

    if (method === "GET" && path === "/core/groups/")
      return json(
        page(
          groups.filter((g) => !q.get("name") || g.name === q.get("name")),
          q,
        ),
      );
    if (method === "POST" && path === "/core/groups/") {
      if (groups.some((g) => g.name === body.name))
        return json({ name: ["group with this name already exists."] }, 400);
      const created = fakeGroup(
        crypto.randomUUID(),
        body.name,
        body.attributes ?? {},
      );
      groups.push(created);
      return json(created, 201);
    }
    const byPk = path.match(/^\/core\/groups\/([^/]+)\/$/);
    if (byPk) {
      const i = groups.findIndex((g) => g.pk === byPk[1]);
      if (i < 0) return notFound();
      if (method === "GET") return json(groups[i]);
      if (method === "DELETE") {
        groups.splice(i, 1);
        users.forEach((u) => {
          u.groups = u.groups.filter((g) => g !== byPk[1]);
        });
        return noContent();
      }
    }
    const member = path.match(/^\/core\/groups\/([^/]+)\/(add|remove)_user\/$/);
    if (method === "POST" && member) {
      const [, groupPk = "", op] = member;
      const user = users.find((u) => u.pk === body.pk);
      if (!user || !groups.some((g) => g.pk === groupPk)) return notFound();
      user.groups =
        op === "add"
          ? [...new Set([...user.groups, groupPk])]
          : user.groups.filter((g) => g !== groupPk);
      return noContent();
    }

    if (method === "GET" && path === "/core/authenticated_sessions/")
      return json(
        page(
          sessions.filter((s) => s.username === q.get("user__username")),
          q,
        ),
      );
    const session = path.match(/^\/core\/authenticated_sessions\/([^/]+)\/$/);
    if (method === "DELETE" && session) {
      const i = sessions.findIndex((s) => s.uuid === session[1]);
      if (i < 0) return notFound();
      sessions.splice(i, 1);
      return noContent();
    }

    if (method === "GET" && path === "/core/users/") {
      const inGroups = q.getAll("groups_by_pk");
      return json(
        page(
          users.filter(
            (u) =>
              (!q.get("email") || u.email === q.get("email")) &&
              (!q.get("username") || u.username === q.get("username")) &&
              inGroups.every((g) => u.groups.includes(g)),
          ),
          q,
        ),
      );
    }
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
    if (!one || !user) return notFound();
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
    groups,
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

// A tagged learner, the only kind the guard lets the app write.
export const fakeLearner = (pk: number, over: Partial<FakeUser> = {}) =>
  fakeUser({
    pk,
    username: `learner-${pk}@x.test`,
    email: `learner-${pk}@x.test`,
    attributes: { hol_learner: true },
    ...over,
  });
