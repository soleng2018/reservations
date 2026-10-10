import "server-only";
import { err, ok, type Result } from "@/lib/result";
import { ADMIN_GROUP } from "@/server/auth/resolve-sign-in";
import { call, type AuthentikFailure, type CoreApi, type User } from "./client";

// Every Authentik user or group write passes this module (spec 0003 AC-4).
// The provisioning token's RBAC cannot tell an admin from a learner, so the
// containment lives here: never write an admin, only write tagged learners
// (except the guest saga's tag step), and only touch `pod-*` groups.

export const POD_GROUP_PREFIX = "pod-";

// "tag": the guest saga adding the learner attributes to a reused user, the
// one write allowed on an untagged user. "learner": everything else.
export type UserWritePurpose = "tag" | "learner";

export type UserTarget = {
  readonly isSuperuser: boolean;
  readonly groups: readonly string[]; // group uuids
  readonly attributes: Readonly<Record<string, unknown>>;
};

export type UserRefusal = "is_admin" | "not_learner";
export type GroupRefusal = "not_pod_group";

export const isTaggedLearner = (attributes: UserTarget["attributes"]) =>
  attributes.hol_learner === true;

// Pure: may this write touch this user?
export function checkUserWrite(
  target: UserTarget,
  adminGroupUuid: string,
  purpose: UserWritePurpose,
): Result<void, UserRefusal> {
  if (target.isSuperuser || target.groups.includes(adminGroupUuid))
    return err("is_admin");
  if (purpose === "learner" && !isTaggedLearner(target.attributes))
    return err("not_learner");
  return ok(undefined);
}

// Pure: may this write touch this group?
export function checkGroupWrite(name: string): Result<void, GroupRefusal> {
  return name.startsWith(POD_GROUP_PREFIX) &&
    name.length > POD_GROUP_PREFIX.length
    ? ok(undefined)
    : err("not_pod_group");
}

// The admin group's uuid, looked up once per process. A missing group means
// setup never ran: every user write is refused as unavailable.
const cache = globalThis as typeof globalThis & { holAdminGroup?: string };

async function adminGroupUuid(
  api: CoreApi,
): Promise<Result<string, AuthentikFailure>> {
  if (cache.holAdminGroup) return ok(cache.holAdminGroup);
  const found = await call("groups.list admin", () =>
    api.coreGroupsList({ name: ADMIN_GROUP, pageSize: 2 }),
  );
  if (!found.ok) return found;
  const matches = found.value.results.filter((g) => g.name === ADMIN_GROUP);
  const [group] = matches;
  if (matches.length !== 1 || !group) {
    console.error(`authentik: expected one ${ADMIN_GROUP} group`);
    return err("unavailable");
  }
  cache.holAdminGroup = group.pk;
  return ok(group.pk);
}

const toTarget = (u: User): UserTarget => ({
  isSuperuser: u.isSuperuser,
  groups: u.groups ?? [],
  attributes: u.attributes ?? {},
});

// Re-reads the user from Authentik (never trusting the DB) and checks the
// write. Returns the fresh user so the caller can merge attributes.
export async function guardUserWrite(
  api: CoreApi,
  pk: number,
  purpose: UserWritePurpose,
): Promise<Result<User, UserRefusal | AuthentikFailure>> {
  const admins = await adminGroupUuid(api);
  if (!admins.ok) return admins;
  const user = await call("users.retrieve", () =>
    api.coreUsersRetrieve({ id: pk }),
  );
  if (!user.ok) return user;
  const allowed = checkUserWrite(toTarget(user.value), admins.value, purpose);
  if (!allowed.ok) {
    console.warn(
      `authentik guard: refused ${purpose} write on ${pk}: ${allowed.error}`,
    );
    return allowed;
  }
  return user;
}

// Re-reads the group and checks its name before a membership or delete.
export async function guardGroupWrite(
  api: CoreApi,
  groupUuid: string,
): Promise<Result<void, GroupRefusal | AuthentikFailure>> {
  const group = await call("groups.retrieve", () =>
    api.coreGroupsRetrieve({ groupUuid }),
  );
  if (!group.ok) return group;
  const allowed = checkGroupWrite(group.value.name);
  if (!allowed.ok)
    console.warn(`authentik guard: refused write on group ${groupUuid}`);
  return allowed;
}
