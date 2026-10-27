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
  // ISO time of the last sign in; absent or null means never.
  last_login?: string | null;
};

export type FakeSession = { uuid: string; user: number; username: string };

export type FakeGroup = {
  pk: string;
  name: string;
  attributes: Record<string, unknown>;
  is_superuser: boolean;
  // Parent group uuids and role ids, both empty on a flat group.
  parents: string[];
  roles: string[];
  // The SDK's mappers require this field on every group.
  roles_obj: never[];
};

export const fakeGroup = (
  pk: string,
  name: string,
  attributes: Record<string, unknown> = {},
  over: Partial<Pick<FakeGroup, "is_superuser" | "parents" | "roles">> = {},
): FakeGroup => ({
  pk,
  name,
  attributes,
  is_superuser: false,
  parents: [],
  roles: [],
  roles_obj: [],
  ...over,
});

// A group the owner's script made and marked for testbeds (spec 0017).
export const markedGroup = (
  pk: string,
  name: string,
  over: Partial<Pick<FakeGroup, "is_superuser" | "parents" | "roles">> = {},
): FakeGroup => fakeGroup(pk, name, { hol_testbed_group: true }, over);

// The pk the fake gives the first user it creates; the next gets one more.
export const FAKE_NEW_PK = 900_100;

export const ADMINS = fakeGroup("admins-uuid", "hol-admins");
export const TESTBED_GROUP = markedGroup(
  "testbed-group-uuid",
  "NileWorkshop1Admin",
);

// Authentik's `attributes` filter: a JSON object whose every key must equal
// the group's attribute.
const hasAttributes = (g: FakeGroup, filter: string | null) =>
  !filter ||
  Object.entries(JSON.parse(filter) as Record<string, unknown>).every(
    ([k, v]) => g.attributes[k] === v,
  );

export function fakeAuthentik(
  initial: readonly FakeUser[],
  opts: {
    readonly down?: boolean;
    readonly sessions?: readonly FakeSession[];
    readonly groups?: readonly FakeGroup[];
    // Answer 500 to the matching requests, e.g. one group's reads.
    readonly fail?: (method: string, path: string) => boolean;
    // Answer with this exact response to the matching requests, e.g. a 403
    // or a body that is not JSON.
    readonly reply?: (method: string, path: string) => Response | undefined;
  } = {},
) {
  const users = initial.map((u) => ({ ...u, groups: [...u.groups] }));
  const sessions = (opts.sessions ?? []).map((s) => ({ ...s }));
  const writes: string[] = [];
  // Every group read, so a test can check none asked for the members.
  const groupReads: { path: string; includeUsers: string | null }[] = [];
  const groups = [ADMINS, TESTBED_GROUP, fakeGroup("other-uuid", "staff")]
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
    const replied = opts.reply?.(method, path);
    if (replied) return replied;
    if (method !== "GET") writes.push(`${method} ${path}`);
    const q = url.searchParams;

    if (method === "GET" && /^\/core\/groups\//.test(path))
      groupReads.push({ path, includeUsers: q.get("include_users") });

    if (method === "GET" && path === "/core/groups/")
      return json(
        page(
          groups.filter(
            (g) =>
              (!q.get("name") || g.name === q.get("name")) &&
              hasAttributes(g, q.get("attributes")),
          ),
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
      // Like Authentik's filter: an unknown group is a bad choice, not a 404.
      if (inGroups.some((g) => !groups.some((x) => x.pk === g)))
        return json({ groups_by_pk: ["Select a valid choice."] }, 400);
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
        // Far above the real Authentik's pks: dev and prod share one
        // database, and a real learner's row already holds pk 100.
        pk: FAKE_NEW_PK + users.length,
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
    if (method === "PATCH") {
      // Like Authentik: a username is unique.
      if (
        body.username &&
        users.some((u) => u.pk !== user.pk && u.username === body.username)
      )
        return json(
          { username: ["A user with that username already exists."] },
          400,
        );
      // A session names its user's current username.
      if (body.username)
        sessions.forEach((x) => {
          if (x.user === user.pk) x.username = body.username;
        });
      return json(Object.assign(user, body));
    }
    if (method === "DELETE") return noContent();
    return json({}, 405);
  };

  return {
    users,
    sessions,
    groups,
    writes,
    groupReads,
    api: createCoreApi(
      { AUTHENTIK_URL: "https://auth.test", token: "t" },
      fetchApi,
    ),
  };
}

// The recorded writes that create, update, or delete a group (spec 0017
// AC-4): everything but a membership change. Always empty in a correct app.
export const groupWrites = (writes: readonly string[]) =>
  writes.filter(
    (w) => /\/core\/groups\//.test(w) && !/\/(add|remove)_user\/$/.test(w),
  );

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
