import { describe, expect, it } from "vitest";
import { createCoreApi } from "./client";
import { addToPodGroup } from "./groups";
import {
  deleteSagaLearner,
  findOrCreateLearner,
  issueSetPasswordLink,
} from "./learners";

// A small in memory Authentik behind the real SDK, recording every write.
type FakeUser = {
  pk: number;
  username: string;
  name: string;
  email: string;
  is_active: boolean;
  is_superuser: boolean;
  groups: string[];
  attributes: Record<string, unknown>;
};

// The SDK's mappers require these fields on every group.
const group = (pk: string, name: string) => ({ pk, name, roles_obj: [] });
const ADMINS = group("admins-uuid", "hol-admins");
const POD = group("pod-uuid", "pod-lab-1");
const PAGE = { pagination: { count: 0 } };

function fakeAuthentik(
  initial: readonly FakeUser[],
  opts: { readonly down?: boolean } = {},
) {
  const users = initial.map((u) => ({ ...u }));
  const writes: string[] = [];
  const groups = [ADMINS, POD, group("other-uuid", "staff")];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

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
    if (method === "POST" && /\/core\/groups\/[^/]+\/add_user\/$/.test(path))
      return new Response(null, { status: 204 });

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
    if (one[2]) return json({ link: `https://auth.test/recover/${user.pk}` });
    if (method === "GET") return json(user);
    if (method === "PATCH") return json(Object.assign(user, body));
    if (method === "DELETE") return new Response(null, { status: 204 });
    return json({}, 405);
  };

  return {
    users,
    writes,
    api: createCoreApi(
      { AUTHENTIK_URL: "https://auth.test", token: "t" },
      fetchApi,
    ),
  };
}

const user = (over: Partial<FakeUser>): FakeUser => ({
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

const input = { email: "Priya@X.test", name: "Priya", holUserId: "row-1" };

describe("findOrCreateLearner (AC-5)", () => {
  it("creates one passwordless learner for a new email", async () => {
    const ak = fakeAuthentik([]);
    const r = await findOrCreateLearner(ak.api, input);
    expect(r).toEqual({
      ok: true,
      value: { pk: 100, created: true, tagged: false },
    });
    expect(ak.writes).toEqual(["POST /core/users/"]);
    expect(ak.users[0]).toMatchObject({
      username: "priya@x.test",
      email: "Priya@X.test",
      path: "hol/learners",
      is_active: true,
      attributes: { hol_learner: true, hol_user_id: "row-1" },
    });
    expect(ak.users[0]).not.toHaveProperty("password");
  });

  it("reuses a known non admin user, adding only the missing attributes", async () => {
    const ak = fakeAuthentik([
      user({ email: "Priya@X.test", attributes: { team: "a" } }),
    ]);
    const r = await findOrCreateLearner(ak.api, input);
    expect(r).toEqual({
      ok: true,
      value: { pk: 7, created: false, tagged: true },
    });
    expect(ak.writes).toEqual(["PATCH /core/users/7/"]);
    expect(ak.users[0]?.attributes).toEqual({
      team: "a",
      hol_learner: true,
      hol_user_id: "row-1",
    });
  });

  it("writes nothing for an already tagged user", async () => {
    const ak = fakeAuthentik([
      user({
        email: "Priya@X.test",
        attributes: { hol_learner: true, hol_user_id: "row-1" },
      }),
    ]);
    expect(await findOrCreateLearner(ak.api, input)).toEqual({
      ok: true,
      value: { pk: 7, created: false, tagged: false },
    });
    expect(ak.writes).toEqual([]);
  });

  it("refuses an admin email without writing", async () => {
    const ak = fakeAuthentik([
      user({ email: "Priya@X.test", groups: [ADMINS.pk] }),
    ]);
    expect(await findOrCreateLearner(ak.api, input)).toEqual({
      ok: false,
      error: "is_admin",
    });
    expect(ak.writes).toEqual([]);
  });

  it("refuses a username taken by a different email", async () => {
    const ak = fakeAuthentik([
      user({ username: "priya@x.test", email: "other@x.test" }),
    ]);
    expect(await findOrCreateLearner(ak.api, input)).toEqual({
      ok: false,
      error: "username_taken",
    });
    expect(ak.writes).toEqual([]);
  });

  it("refuses an inactive Authentik account", async () => {
    const ak = fakeAuthentik([
      user({ email: "Priya@X.test", is_active: false }),
    ]);
    expect(await findOrCreateLearner(ak.api, input)).toEqual({
      ok: false,
      error: "refused",
    });
  });

  it("returns unavailable when Authentik cannot be reached (AC-15)", async () => {
    const ak = fakeAuthentik([], { down: true });
    expect(await findOrCreateLearner(ak.api, input)).toEqual({
      ok: false,
      error: "unavailable",
    });
  });
});

describe("guarded writes (AC-4, AC-6)", () => {
  const admin = user({
    pk: 1,
    groups: [ADMINS.pk],
    attributes: { hol_learner: true },
  });
  const plain = user({ pk: 2 });
  const learner = user({ pk: 3, attributes: { hol_learner: true } });

  it("never issues a recovery link for an admin or an untagged user", async () => {
    const ak = fakeAuthentik([admin, plain, learner]);
    expect(await issueSetPasswordLink(ak.api, 1)).toEqual({
      ok: false,
      error: "is_admin",
    });
    expect(await issueSetPasswordLink(ak.api, 2)).toEqual({
      ok: false,
      error: "not_learner",
    });
    expect(await issueSetPasswordLink(ak.api, 3)).toEqual({
      ok: true,
      value: "https://auth.test/recover/3",
    });
    expect(ak.writes).toEqual(["POST /core/users/3/recovery/"]);
  });

  it("never deletes an admin", async () => {
    const ak = fakeAuthentik([admin]);
    expect((await deleteSagaLearner(ak.api, 1)).ok).toBe(false);
    expect(ak.writes).toEqual([]);
  });

  it("adds learners to pod- groups only", async () => {
    const ak = fakeAuthentik([learner, admin]);
    expect(await addToPodGroup(ak.api, ADMINS.pk, 3)).toEqual({
      ok: false,
      error: "not_pod_group",
    });
    expect(await addToPodGroup(ak.api, "other-uuid", 3)).toEqual({
      ok: false,
      error: "not_pod_group",
    });
    expect(await addToPodGroup(ak.api, POD.pk, 1)).toEqual({
      ok: false,
      error: "is_admin",
    });
    expect(ak.writes).toEqual([]);
    expect((await addToPodGroup(ak.api, POD.pk, 3)).ok).toBe(true);
    expect(ak.writes).toEqual([`POST /core/groups/${POD.pk}/add_user/`]);
  });
});
