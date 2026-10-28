import "server-only";
import { err, ok, type Result } from "@/lib/result";
import { ADMIN_GROUP } from "@/server/auth/resolve-sign-in";
import {
  call,
  type AuthentikFailure,
  type CoreApi,
  type Group,
  type User,
} from "./client";

// Every Authentik user or group write passes this module (spec 0003 AC-4,
// spec 0017 AC-3). The provisioning token's RBAC cannot tell an admin from a
// learner, so the containment lives here: never write an admin, only write
// tagged learners (except the guest saga's tag step), and only change the
// membership of a group the owner marked for testbeds.

// The attribute the owner's script sets, as the boolean `true`, on every group
// that may back a testbed. The HOL Labs gate reads the same marker.
export const TESTBED_GROUP_MARKER = "hol_testbed_group";

// "tag": the guest saga adding the learner attributes to a reused user, the
// one write allowed on an untagged user. "learner": everything else.
export type UserWritePurpose = "tag" | "learner";

export type UserTarget = {
  readonly isSuperuser: boolean;
  readonly groups: readonly string[]; // group uuids
  readonly attributes: Readonly<Record<string, unknown>>;
};

// "add": a learner joins the group, so it must be a flat, marked testbed
// group. "remove": a learner leaves, which is allowed on any group but the
// admin one, so a group that lost its marker still lets ended learners out.
export type GroupWritePurpose = "add" | "remove";

export type GroupTarget = {
  readonly pk: string;
  readonly name: string;
  // `undefined` for this and the two lists below means Authentik did not say,
  // which is refused for an add rather than read as "no".
  readonly isSuperuser: boolean | undefined;
  readonly parents: readonly string[] | undefined;
  readonly roles: readonly string[] | undefined;
  readonly attributes: Readonly<Record<string, unknown>>;
};

export type UserRefusal = "is_admin" | "not_learner";
export type GroupRefusal = "not_testbed_group";

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

const isAdminGroup = (group: GroupTarget, adminGroupUuid: string) =>
  group.pk === adminGroupUuid ||
  group.name.toLowerCase() === ADMIN_GROUP.toLowerCase();

// A group learners may be added to: marked with the boolean `true` (the
// string "true" is not enough), not a superuser group, and flat, since a
// parent or a role could hand its members admin rights.
const isUsableTestbedGroup = (group: GroupTarget) =>
  group.attributes[TESTBED_GROUP_MARKER] === true &&
  group.isSuperuser === false &&
  group.parents?.length === 0 &&
  group.roles?.length === 0;

// Pure: may this write touch this group?
export function checkGroupWrite(
  group: GroupTarget,
  purpose: GroupWritePurpose,
  adminGroupUuid: string,
): Result<void, GroupRefusal> {
  if (isAdminGroup(group, adminGroupUuid)) return err("not_testbed_group");
  if (purpose === "add" && !isUsableTestbedGroup(group))
    return err("not_testbed_group");
  return ok(undefined);
}

// The admin group's uuid, looked up once per process. A missing group means
// setup never ran: every user write is refused as unavailable.
const cache = globalThis as typeof globalThis & { holAdminGroup?: string };

export async function adminGroupUuid(
  api: CoreApi,
): Promise<Result<string, AuthentikFailure>> {
  if (cache.holAdminGroup) return ok(cache.holAdminGroup);
  const found = await call("groups.list admin", () =>
    api.coreGroupsList({
      name: ADMIN_GROUP,
      pageSize: 2,
      includeUsers: false,
    }),
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

export const toGroupTarget = (g: Group): GroupTarget => ({
  pk: g.pk,
  name: g.name,
  isSuperuser: g.isSuperuser,
  parents: g.parents,
  roles: g.roles,
  attributes: g.attributes ?? {},
});

// Re-reads the group (never its members) and checks it before a membership
// write. Returns the fresh group so the caller can use its name.
export async function guardGroupWrite(
  api: CoreApi,
  groupUuid: string,
  purpose: GroupWritePurpose,
): Promise<Result<Group, GroupRefusal | AuthentikFailure>> {
  const admins = await adminGroupUuid(api);
  if (!admins.ok) return admins;
  const group = await call("groups.retrieve", () =>
    api.coreGroupsRetrieve({ groupUuid, includeUsers: false }),
  );
  if (!group.ok) return group;
  const allowed = checkGroupWrite(
    toGroupTarget(group.value),
    purpose,
    admins.value,
  );
  if (!allowed.ok) {
    console.warn(
      `authentik guard: refused ${purpose} write on group ${groupUuid}`,
    );
    return allowed;
  }
  return group;
}

// Spec 0023 AC-42: the one non learner user the app writes. For each
// workshop it owns `automation@<domain>`, which the reset engine signs in
// as. Exactly three writes pass `guardAutomationWrite`: create the user, set
// its password, and add it to the testbed's access group. It never reaches a
// user the app did not make (no marker), an admin, or a superuser.
export const AUTOMATION_MARKER = "hol_portal_automation";
export const AUTOMATION_DOMAIN_ATTRIBUTE = "hol_testbed_domain";

export const automationUsername = (domain: string) => `automation@${domain}`;

export type AutomationWrite =
  | { readonly kind: "create"; readonly domain: string }
  | {
      readonly kind: "set_password";
      readonly domain: string;
      readonly pk: number;
    }
  | {
      readonly kind: "add_to_group";
      readonly domain: string;
      readonly pk: number;
      readonly groupUuid: string;
    };

export type AutomationRefusal =
  | "exists" // a create, but the username is already someone's
  | "is_admin"
  | "not_automation" // no marker, or the pk is not the automation username
  | "not_testbed_group"; // unmarked, wrong domain, or an admin group

// Pure: may this write touch this user? `username` is the user's own.
export function checkAutomationUser(
  target: UserTarget & { readonly username: string },
  adminGroupUuid: string,
  domain: string,
): Result<void, AutomationRefusal> {
  if (target.username !== automationUsername(domain))
    return err("not_automation");
  if (target.isSuperuser || target.groups.includes(adminGroupUuid))
    return err("is_admin");
  return target.attributes[AUTOMATION_MARKER] === true
    ? ok(undefined)
    : err("not_automation");
}

// Pure: a flat marked group whose `hol_testbed_domain` is this domain.
export function checkAutomationGroup(
  group: GroupTarget,
  adminGroupUuid: string,
  domain: string,
): Result<void, AutomationRefusal> {
  const allowed = checkGroupWrite(group, "add", adminGroupUuid);
  return allowed.ok && group.attributes[AUTOMATION_DOMAIN_ATTRIBUTE] === domain
    ? ok(undefined)
    : err("not_testbed_group");
}

// Re-reads the target from Authentik before the write, like the learner
// guard. A create is allowed only when nobody holds the username.
export async function guardAutomationWrite(
  api: CoreApi,
  write: AutomationWrite,
): Promise<Result<void, AutomationRefusal | AuthentikFailure>> {
  const admins = await adminGroupUuid(api);
  if (!admins.ok) return admins;
  const refuse = (reason: AutomationRefusal) => {
    console.warn(
      `authentik guard: refused automation ${write.kind}: ${reason}`,
    );
    return err(reason);
  };
  if (write.kind === "create") {
    const found = await call("users.list automation", () =>
      api.coreUsersList({
        username: automationUsername(write.domain),
        pageSize: 5,
      }),
    );
    if (!found.ok) return found;
    return found.value.results.some(
      (u) => u.username === automationUsername(write.domain),
    )
      ? refuse("exists")
      : ok(undefined);
  }
  const user = await call("users.retrieve automation", () =>
    api.coreUsersRetrieve({ id: write.pk }),
  );
  if (!user.ok) return user;
  const userOk = checkAutomationUser(
    { ...toTarget(user.value), username: user.value.username },
    admins.value,
    write.domain,
  );
  if (!userOk.ok) return refuse(userOk.error);
  if (write.kind === "set_password") return ok(undefined);
  const group = await call("groups.retrieve automation", () =>
    api.coreGroupsRetrieve({ groupUuid: write.groupUuid, includeUsers: false }),
  );
  if (!group.ok) return group;
  const groupOk = checkAutomationGroup(
    toGroupTarget(group.value),
    admins.value,
    write.domain,
  );
  return groupOk.ok ? ok(undefined) : refuse(groupOk.error);
}
