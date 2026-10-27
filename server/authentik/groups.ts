import "server-only";
import { DomainInput } from "@/lib/catalog-input";
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
  TESTBED_GROUP_MARKER,
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
  // Spec 0017 AC-21: the group's `hol_testbed_domain`, parsed; null when
  // missing or not a valid domain.
  readonly domain: string | null;
};

export type GroupMember = {
  readonly pk: number;
  readonly holLearner: boolean;
};

const MEMBERS_PAGE = 100;
// Authentik's `name` filter is exact; the page is wide anyway, so a looser
// filter still finds the exact name in code.
const LOOKUP_PAGE = 100;

// Spec 0017 AC-17, AC-21: the one parse of a group's domain attribute, shared
// by the add form's choices and the create lookup. Missing, not a string, or
// not a domain gives null.
export const parseGroupDomain = (g: Group): string | null => {
  const parsed = DomainInput.safeParse(
    g.attributes?.[TESTBED_GROUP_DOMAIN_ATTRIBUTE],
  );
  return parsed.success ? parsed.data : null;
};

const toTestbedGroup = (g: Group): TestbedGroup => ({
  pk: g.pk,
  name: g.name,
  domain: parseGroupDomain(g),
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
async function unreadableIsUnavailable<T, E extends string>(
  run: () => Promise<Result<T, E | AuthentikFailure>>,
): Promise<Result<T, E | AuthentikFailure>> {
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

// Spec 0017 AC-17: the attribute the owner may add to a marked group, a
// domain such as `nileworkshop-1.com`, to prefill the add form's Domain.
export const TESTBED_GROUP_DOMAIN_ATTRIBUTE = "hol_testbed_domain";

const CHOICE_PAGE = 100;
const CHOICE_MAX_PAGES = 5;

// A group the add form may offer. The `pk` stays on the server: the caller
// uses it to hide used groups, then drops it.
export type TestbedGroupChoice = {
  readonly pk: string;
  readonly name: string;
  readonly domain: string | null;
};

// Spec 0017 AC-17: the group's domain, parsed like a typed one. Missing, not a
// string, or not a domain gives null; a bad value is warned about by group
// name only, never by value.
export function toGroupChoice(g: Group): TestbedGroupChoice {
  const domain = parseGroupDomain(g);
  if (
    domain === null &&
    g.attributes?.[TESTBED_GROUP_DOMAIN_ATTRIBUTE] !== undefined
  )
    console.warn(
      `authentik: group ${g.name} has an invalid ${TESTBED_GROUP_DOMAIN_ATTRIBUTE}`,
    );
  return { pk: g.pk, name: g.name, domain };
}

// Spec 0017 AC-15: the marked groups the add form offers, sorted by name
// ignoring case. One paged read, at most 5 pages. A group is kept only when
// it passes the same "add" check as the save and no other group in the read
// carries its name (the save would refuse it). The marker alone picks groups.
export const listTestbedGroupChoices = (
  api: CoreApi,
): Promise<Result<readonly TestbedGroupChoice[], AuthentikFailure>> =>
  unreadableIsUnavailable<readonly TestbedGroupChoice[], never>(async () => {
    const admins = await adminGroupUuid(api);
    if (!admins.ok) return err("unavailable");
    const page = async (
      n: number,
      acc: readonly Group[],
    ): Promise<Result<readonly Group[], AuthentikFailure>> => {
      const res = await call("groups.list marked", () =>
        api.coreGroupsList({
          attributes: JSON.stringify({ [TESTBED_GROUP_MARKER]: true }),
          page: n,
          pageSize: CHOICE_PAGE,
          includeUsers: false,
        }),
      );
      if (!res.ok) return res;
      const all = [...acc, ...res.value.results];
      const next = res.value.pagination.next;
      return next > n && n < CHOICE_MAX_PAGES ? page(next, all) : ok(all);
    };
    const read = await page(1, []);
    if (!read.ok) return err("unavailable");
    const count = (name: string) =>
      read.value.filter((g) => g.name === name).length;
    return ok(
      read.value
        .filter(
          (g) =>
            count(g.name) === 1 &&
            checkGroupWrite(toGroupTarget(g), "add", admins.value).ok,
        )
        .map(toGroupChoice)
        .toSorted((a, b) =>
          a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
        ),
    );
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
