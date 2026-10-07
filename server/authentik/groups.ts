import "server-only";
import { type Result } from "@/lib/result";
import { call, type AuthentikFailure, type CoreApi } from "./client";
import {
  guardGroupWrite,
  guardUserWrite,
  type GroupRefusal,
  type UserRefusal,
} from "./guard";

// Testbed `pod-*` group membership (spec 0003 AC-4). Both the group and the
// user are re-read and checked before each write.

export type MembershipError = GroupRefusal | UserRefusal | AuthentikFailure;

async function guarded(
  api: CoreApi,
  groupUuid: string,
  userPk: number,
): Promise<Result<void, MembershipError>> {
  const group = await guardGroupWrite(api, groupUuid);
  if (!group.ok) return group;
  const user = await guardUserWrite(api, userPk, "learner");
  return user.ok ? group : user;
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
