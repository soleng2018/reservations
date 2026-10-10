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
  checkGroupWrite,
  guardGroupWrite,
  guardUserWrite,
  isTaggedLearner,
  POD_GROUP_PREFIX,
  type GroupRefusal,
  type UserRefusal,
} from "./guard";

// Testbed `pod-*` groups and their membership (spec 0003 AC-4, spec 0004
// AC-2 and AC-12). Every write re-reads its target through the guard first.

export type MembershipError = GroupRefusal | UserRefusal | AuthentikFailure;

export type PodGroup = {
  readonly pk: string;
  readonly name: string;
  // The testbeds.id this app stamped on the group at create, if any.
  readonly testbedId: string | undefined;
};

export type PodMember = { readonly pk: number; readonly holLearner: boolean };

const MEMBERS_PAGE = 100;

export const podGroupName = (slug: string) => `${POD_GROUP_PREFIX}${slug}`;

const toPodGroup = (g: Group): PodGroup => {
  const id: unknown = g.attributes?.hol_testbed_id;
  return {
    pk: g.pk,
    name: g.name,
    testbedId: typeof id === "string" ? id : undefined,
  };
};

const toMember = (u: User): PodMember => ({
  pk: u.pk,
  holLearner: isTaggedLearner(u.attributes ?? {}),
});

async function guarded(
  api: CoreApi,
  groupUuid: string,
  userPk: number,
): Promise<Result<void, MembershipError>> {
  const group = await guardGroupWrite(api, groupUuid);
  if (!group.ok) return group;
  const user = await guardUserWrite(api, userPk, "learner");
  return user.ok ? ok(undefined) : user;
}

export async function addToPodGroup(
  api: CoreApi,
  groupUuid: string,
  userPk: number,
): Promise<Result<void, MembershipError>> {
  const allowed = await guarded(api, groupUuid, userPk);
  if (!allowed.ok) return allowed;
  return call("groups.add_user", () =>
    api.coreGroupsAddUserCreate({
      groupUuid,
      userAccountRequest: { pk: userPk },
    }),
  );
}

export async function removeFromPodGroup(
  api: CoreApi,
  groupUuid: string,
  userPk: number,
): Promise<Result<void, MembershipError>> {
  const allowed = await guarded(api, groupUuid, userPk);
  if (!allowed.ok) return allowed;
  return call("groups.remove_user", () =>
    api.coreGroupsRemoveUserCreate({
      groupUuid,
      userAccountRequest: { pk: userPk },
    }),
  );
}

// The group with exactly this name, or undefined.
export async function findPodGroupByName(
  api: CoreApi,
  name: string,
): Promise<Result<PodGroup | undefined, AuthentikFailure>> {
  const found = await call("groups.list by name", () =>
    api.coreGroupsList({ name, pageSize: 2 }),
  );
  if (!found.ok) return found;
  const group = found.value.results.find((g) => g.name === name);
  return ok(group && toPodGroup(group));
}

// AC-2: a new group stamped with `hol_testbed_id`. An existing group of the
// same name is never adopted, so a stray or foreign group is left alone.
export async function createPodGroup(
  api: CoreApi,
  name: string,
  testbedId: string,
): Promise<Result<PodGroup, GroupRefusal | AuthentikFailure | "exists">> {
  const allowed = checkGroupWrite(name);
  if (!allowed.ok) return allowed;
  const existing = await findPodGroupByName(api, name);
  if (!existing.ok) return existing;
  if (existing.value) return err("exists");
  const created = await call("groups.create", () =>
    api.coreGroupsCreate({
      groupRequest: { name, attributes: { hol_testbed_id: testbedId } },
    }),
  );
  return created.ok ? ok(toPodGroup(created.value)) : created;
}

// Deletes a pod group only if it still carries this testbed's id (the
// invariant behind the create undo and its sweeper).
export async function deletePodGroup(
  api: CoreApi,
  groupUuid: string,
  testbedId: string,
): Promise<Result<void, GroupRefusal | AuthentikFailure | "not_owned">> {
  const group = await guardGroupWrite(api, groupUuid);
  if (!group.ok) return group;
  if (toPodGroup(group.value).testbedId !== testbedId) {
    console.warn(`authentik: group ${groupUuid} is not testbed ${testbedId}'s`);
    return err("not_owned");
  }
  return call("groups.destroy", () => api.coreGroupsDestroy({ groupUuid }));
}

// AC-12: every member of the group with its learner tag, read 100 per page.
export async function podGroupMembers(
  api: CoreApi,
  groupUuid: string,
): Promise<Result<readonly PodMember[], AuthentikFailure>> {
  const page = async (
    n: number,
    acc: readonly PodMember[],
  ): Promise<Result<readonly PodMember[], AuthentikFailure>> => {
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
