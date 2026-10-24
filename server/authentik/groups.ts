import "server-only";
import { err, ok, type Result } from "@/lib/result";
import {
  call,
  type AuthentikFailure,
  type CoreApi,
  type Group,
  type User,
} from "./client";
import {
  adminGroupUuid,
  checkGroupWrite,
  guardGroupWrite,
  guardUserWrite,
  isTaggedLearner,
  toGroupTarget,
  type GroupRefusal,
  type UserRefusal,
} from "./guard";

// Testbed groups and their membership (spec 0003 AC-4, spec 0017 AC-3,
// AC-4). The owner makes the groups; the app only reads them and adds or
// removes members. Every write re-reads its target through the guard first.
// No code here creates, updates, or deletes a group (tests/group-writes-scan).

export type MembershipError = GroupRefusal | UserRefusal | AuthentikFailure;

export type TestbedGroup = {
  readonly pk: string;
  readonly name: string;
};

export type GroupMember = {
  readonly pk: number;
  readonly holLearner: boolean;
};

const MEMBERS_PAGE = 100;
// Authentik's `name` filter is exact; the page is wide anyway, so a looser
// filter still finds the exact name in code.
const LOOKUP_PAGE = 100;

const toTestbedGroup = (g: Group): TestbedGroup => ({
  pk: g.pk,
  name: g.name,
});

const toMember = (u: User): GroupMember => ({
  pk: u.pk,
  holLearner: isTaggedLearner(u.attributes ?? {}),
});

async function guarded(
  api: CoreApi,
  groupUuid: string,
  userPk: number,
  purpose: "add" | "remove",
): Promise<Result<void, MembershipError>> {
  const group = await guardGroupWrite(api, groupUuid, purpose);
  if (!group.ok) return group;
  const user = await guardUserWrite(api, userPk, "learner");
  return user.ok ? ok(undefined) : user;
}

export async function addToTestbedGroup(
  api: CoreApi,
  groupUuid: string,
  userPk: number,
): Promise<Result<void, MembershipError>> {
  const allowed = await guarded(api, groupUuid, userPk, "add");
  if (!allowed.ok) return allowed;
  return call("groups.add_user", () =>
    api.coreGroupsAddUserCreate({
      groupUuid,
      userAccountRequest: { pk: userPk },
    }),
  );
}

export async function removeFromTestbedGroup(
  api: CoreApi,
  groupUuid: string,
  userPk: number,
): Promise<Result<void, MembershipError>> {
  const allowed = await guarded(api, groupUuid, userPk, "remove");
  if (!allowed.ok) return allowed;
  return call("groups.remove_user", () =>
    api.coreGroupsRemoveUserCreate({
      groupUuid,
      userAccountRequest: { pk: userPk },
    }),
  );
}

// A reply the SDK cannot read (a body that is not JSON, or not a group page)
// is Authentik misbehaving, not a bug here, so the lookup answers
// `unavailable`. Checked by error name, not instanceof: `Response.json()` can
// throw from another realm.
async function unreadableIsUnavailable<T>(
  run: () => Promise<Result<T, GroupRefusal | AuthentikFailure>>,
): Promise<Result<T, GroupRefusal | AuthentikFailure>> {
  try {
    return await run();
  } catch (e) {
    const name =
      typeof e === "object" && e !== null && "name" in e ? e.name : "";
    if (name !== "SyntaxError" && name !== "TypeError") throw e;
    console.error("authentik: groups.list by name returned an unreadable body");
    return err("unavailable");
  }
}

// Spec 0017 AC-3: the group whose name equals `name` exactly (case
// sensitive) and may back a testbed. None is `not_found`; two or more with
// that exact name, or one that fails the "add" check, are `not_testbed_group`
// (never the first of several). Anything but a clean answer is `unavailable`
// (the client logs the call and its status); a 404 on a list route counts.
export const findTestbedGroup = (
  api: CoreApi,
  name: string,
): Promise<Result<TestbedGroup, GroupRefusal | AuthentikFailure>> =>
  unreadableIsUnavailable(async () => {
    const admins = await adminGroupUuid(api);
    if (!admins.ok) return err("unavailable");
    const found = await call("groups.list by name", () =>
      api.coreGroupsList({ name, pageSize: LOOKUP_PAGE, includeUsers: false }),
    );
    if (!found.ok) return err("unavailable");
    const matches = found.value.results.filter((g) => g.name === name);
    const [match] = matches;
    if (!match) return err("not_found");
    if (matches.length > 1) return err("not_testbed_group");
    const allowed = checkGroupWrite(toGroupTarget(match), "add", admins.value);
    return allowed.ok ? ok(toTestbedGroup(match)) : allowed;
  });

// One group by pk, without its members: its current name, or `not_found`.
export async function readTestbedGroup(
  api: CoreApi,
  groupUuid: string,
): Promise<Result<TestbedGroup, AuthentikFailure>> {
  const group = await call("groups.retrieve", () =>
    api.coreGroupsRetrieve({ groupUuid, includeUsers: false }),
  );
  return group.ok ? ok(toTestbedGroup(group.value)) : group;
}

// Every member of the group with its learner tag, read 100 per page.
export async function testbedGroupMembers(
  api: CoreApi,
  groupUuid: string,
): Promise<Result<readonly GroupMember[], AuthentikFailure>> {
  const page = async (
    n: number,
    acc: readonly GroupMember[],
  ): Promise<Result<readonly GroupMember[], AuthentikFailure>> => {
    const res = await call("users.list by group", () =>
      api.coreUsersList({
        groupsByPk: [groupUuid],
        page: n,
        pageSize: MEMBERS_PAGE,
      }),
    );
    if (!res.ok) return res;
    const all = [...acc, ...res.value.results.map(toMember)];
    const next = res.value.pagination.next;
    return next > n ? page(next, all) : ok(all);
  };
  return page(1, []);
}
