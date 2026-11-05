import "server-only";
import type { TypeGroupOrigin } from "@/lib/db-enums";
import { err, ok, type Result } from "@/lib/result";
import {
  call,
  callWrite,
  policiesApi,
  type AuthentikFailure,
  type CoreApi,
  type Group,
} from "./client";
import {
  adminGroupUuid,
  checkTypeGroupWrite,
  toGroupTarget,
  TYPE_GROUP_ID_ATTRIBUTE,
  TYPE_GROUP_MARKER,
} from "./guard";

// Spec 0026: the one place the app creates, renames, and deletes Authentik
// groups, and only a Testbed Type's. The testbed groups stay the owner's
// (spec 0017); `tests/group-writes-scan.test.ts` keeps these three SDK calls
// out of every other file. Every write below follows a check from
// `checkTypeGroupWrite`, and a group is only ever changed after it is read
// again. Nobody is added to a type group here.

const LOOKUP_PAGE = 5;

export type LookupError = "unsafe" | "unavailable";

// Read only: the safe same name group a type would link to, or null when
// ensureTypeGroup would make one. Used by the backfill's dry run (AC-14).
export async function lookupTypeGroup(
  api: CoreApi,
  name: string,
): Promise<Result<string | null, LookupError>> {
  const admins = await adminGroupUuid(api);
  if (!admins.ok) return err("unavailable");
  const found = await byExactName(api, name);
  if (!found.ok) return err("unavailable");
  const [match] = found.value;
  if (!match) return ok(null);
  const safe =
    found.value.length === 1 &&
    checkTypeGroupWrite(toGroupTarget(match), admins.value, { kind: "link" })
      .ok;
  return safe ? ok(match.pk) : err("unsafe");
}

export type TypeGroupLink = {
  readonly pk: string;
  readonly origin: TypeGroupOrigin;
  // What happened in Authentik: a group was made, or an existing one linked.
  readonly outcome: "created" | "linked";
};

export type EnsureError = "unsafe" | "name_invalid" | "unavailable";

const byExactName = (api: CoreApi, name: string) =>
  call("groups.list by name", () =>
    api.coreGroupsList({ name, pageSize: LOOKUP_PAGE, includeUsers: false }),
  ).then((r) =>
    r.ok ? ok(r.value.results.filter((g) => g.name === name)) : r,
  );

// AC-1 to AC-3: link a safe same name group, or make one. A group the app
// made earlier whose save failed to commit is linked like any other, as
// `reused`, and is never deleted by the app.
export async function ensureTypeGroup(
  api: CoreApi,
  input: { readonly typeId: string; readonly name: string },
): Promise<Result<TypeGroupLink, EnsureError>> {
  const admins = await adminGroupUuid(api);
  if (!admins.ok) return err("unavailable");

  const link = async (): Promise<Result<TypeGroupLink | null, EnsureError>> => {
    const found = await byExactName(api, input.name);
    if (!found.ok) return err("unavailable");
    const [match] = found.value;
    if (!match) return ok(null);
    if (found.value.length > 1) return err("unsafe");
    const allowed = checkTypeGroupWrite(toGroupTarget(match), admins.value, {
      kind: "link",
    });
    if (!allowed.ok) {
      console.warn(`authentik guard: refused type group link ${match.pk}`);
      return err("unsafe");
    }
    return ok({ pk: match.pk, origin: "reused", outcome: "linked" });
  };

  const existing = await link();
  if (!existing.ok || existing.value)
    return existing as Result<TypeGroupLink, EnsureError>;

  const created = await callWrite("groups.create", () =>
    api.coreGroupsCreate({
      groupRequest: {
        name: input.name,
        isSuperuser: false,
        attributes: {
          [TYPE_GROUP_MARKER]: true,
          [TYPE_GROUP_ID_ATTRIBUTE]: input.typeId,
        },
      },
    }),
  );
  if (created.ok)
    return ok({ pk: created.value.pk, origin: "created", outcome: "created" });
  if (created.error !== "rejected") return err("unavailable");

  // A 400: the owner may have made the group a moment ago (AC-4). Look again.
  const again = await link();
  if (!again.ok) return again as Result<TypeGroupLink, EnsureError>;
  return again.value ? ok(again.value) : err("name_invalid");
}

export type RenameOutcome =
  | { readonly kind: "unchanged" }
  | { readonly kind: "renamed" }
  // The group was gone, so a new one was made and the type must store it.
  | { readonly kind: "recreated"; readonly pk: string };

export type RenameError =
  "name_taken" | "changed" | "name_invalid" | "unavailable";

// The only body a rename ever sends (AC-11): the name, never anything else.
const renameBody = (name: string) => ({ name });

// AC-5, AC-6, AC-8: rename the group the app made for this type.
export async function renameTypeGroup(
  api: CoreApi,
  input: {
    readonly typeId: string;
    readonly pk: string;
    readonly name: string;
  },
): Promise<Result<RenameOutcome, RenameError>> {
  const admins = await adminGroupUuid(api);
  if (!admins.ok) return err("unavailable");

  const taken = async (): Promise<Result<boolean, "unavailable">> => {
    const found = await byExactName(api, input.name);
    return found.ok
      ? ok(found.value.some((g) => g.pk !== input.pk))
      : err("unavailable");
  };

  const group = await call("groups.retrieve", () =>
    api.coreGroupsRetrieve({ groupUuid: input.pk, includeUsers: false }),
  );
  if (!group.ok && group.error === "unavailable") return err("unavailable");

  if (!group.ok) {
    // Gone: make a fresh one under the new name (AC-8).
    const clash = await taken();
    if (!clash.ok) return err("unavailable");
    if (clash.value) return err("name_taken");
    const made = await callWrite("groups.create", () =>
      api.coreGroupsCreate({
        groupRequest: {
          name: input.name,
          isSuperuser: false,
          attributes: {
            [TYPE_GROUP_MARKER]: true,
            [TYPE_GROUP_ID_ATTRIBUTE]: input.typeId,
          },
        },
      }),
    );
    if (made.ok) return ok({ kind: "recreated", pk: made.value.pk });
    return err(made.error === "rejected" ? "name_invalid" : "unavailable");
  }

  const allowed = checkTypeGroupWrite(
    toGroupTarget(group.value),
    admins.value,
    { kind: "change", typeId: input.typeId },
  );
  if (!allowed.ok) {
    console.warn(`authentik guard: refused type group rename ${input.pk}`);
    return err("changed");
  }
  if (group.value.name === input.name) return ok({ kind: "unchanged" });

  const clash = await taken();
  if (!clash.ok) return err("unavailable");
  if (clash.value) return err("name_taken");

  const patched = await callWrite("groups.rename", () =>
    api.coreGroupsPartialUpdate({
      groupUuid: input.pk,
      patchedGroupRequest: renameBody(input.name),
    }),
  );
  if (patched.ok) return ok({ kind: "renamed" });
  if (patched.error === "unavailable") return err("unavailable");
  // A 400 or a vanished group: look again for a clash, else the name is bad.
  const clashAfter = await taken();
  if (!clashAfter.ok) return err("unavailable");
  return err(clashAfter.value ? "name_taken" : "name_invalid");
}

export type DeleteOutcome =
  | { readonly kind: "gone" }
  | {
      readonly kind: "deleted";
      readonly memberCount: number;
    }
  | {
      readonly kind: "left";
      readonly reason: "not_ours" | "bound" | "has_children";
    };

const BINDING_PAGE = 100;
const BINDING_MAX_PAGES = 5;

// Does any policy binding point at this group? Authentik's own `used_by`
// answers 500 for the provisioning token, and the bindings list has no group
// filter, so read the bindings (a few dozen) and look. More than five pages
// counts as bound: when in doubt the group is left alone.
async function groupHasBinding(
  api: CoreApi,
  pk: string,
  page = 1,
): Promise<Result<boolean, "unavailable">> {
  const res = await call("policies.bindings list", () =>
    policiesApi(api).policiesBindingsList({ page, pageSize: BINDING_PAGE }),
  );
  if (!res.ok) return err("unavailable");
  if (res.value.results.some((b) => b.group === pk)) return ok(true);
  if (res.value.pagination.next === 0) return ok(false);
  return page >= BINDING_MAX_PAGES
    ? ok(true)
    : groupHasBinding(api, pk, page + 1);
}

const hasChildren = (g: Group) => (g.children ?? []).length > 0;

// AC-9, AC-10: delete the group the app made, unless it is no longer the
// app's or the owner uses it elsewhere. A group with a policy binding is
// never destroyed: removing the binding can open an Authentik app to every
// user.
export async function deleteTypeGroup(
  api: CoreApi,
  input: { readonly typeId: string; readonly pk: string },
): Promise<Result<DeleteOutcome, AuthentikFailure>> {
  const admins = await adminGroupUuid(api);
  if (!admins.ok) return err("unavailable");

  const group = await call("groups.retrieve", () =>
    api.coreGroupsRetrieve({
      groupUuid: input.pk,
      includeUsers: false,
      includeChildren: true,
    }),
  );
  if (!group.ok)
    return group.error === "not_found" ? ok({ kind: "gone" }) : group;

  const allowed = checkTypeGroupWrite(
    toGroupTarget(group.value),
    admins.value,
    { kind: "change", typeId: input.typeId },
  );
  if (!allowed.ok) {
    console.warn(`authentik guard: left type group ${input.pk} in place`);
    return ok({ kind: "left", reason: "not_ours" });
  }
  if (hasChildren(group.value))
    return ok({ kind: "left", reason: "has_children" });

  const bound = await groupHasBinding(api, input.pk);
  if (!bound.ok) return err("unavailable");
  if (bound.value) return ok({ kind: "left", reason: "bound" });

  const members = await call("users.count in group", () =>
    api.coreUsersList({ groupsByPk: [input.pk], pageSize: 1 }),
  );
  if (!members.ok) return err("unavailable");

  const destroyed = await call("groups.destroy", () =>
    api.coreGroupsDestroy({ groupUuid: input.pk }),
  );
  if (!destroyed.ok && destroyed.error === "unavailable")
    return err("unavailable");
  return ok({
    kind: "deleted",
    memberCount: members.value.pagination.count,
  });
}
