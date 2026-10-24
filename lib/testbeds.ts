import type { TestbedClientInput, TestbedUpdateInput } from "./catalog-input";
import { changedFields } from "./changed-fields";

// Testbed admin (spec 0007, spec 0017, spec 0018), safe on both sides. `name`
// is what learners see; `groupName` is the Authentik group, admin side only.

export const TESTBED_MESSAGES = {
  duplicateName: "A testbed with this name already exists.",
  duplicateGroupName: "A testbed with this group name already exists.",
  duplicateDomain: "A testbed with this domain already exists.",
  domainLocked:
    "You can't change the domain while this testbed has Upcoming or Current reservations.",
  typeGone: "That type no longer exists.",
  idpGone: "That IDP key no longer exists.",
  gone: "This testbed no longer exists.",
  groupNotFound: "No Authentik group with this group name exists.",
  groupNotTestbed:
    "That group isn't set up for testbeds. It needs the hol_testbed_group marker.",
  groupInUse: "Another testbed already uses that group.",
  authentikUnavailable: "Couldn't check the Authentik group, try again.",
} as const;

export const TESTBED_NAME_HINT =
  "What learners see in emails, invites, and on screens.";

// Spec 0018 AC-2: the hint under the Group Name field. It is typed once and
// then read only.
export const TESTBED_GROUP_NAME_HINT = {
  create:
    "Must be the exact name of an Authentik group the owner has set up for this lab.",
  edit: "The group name can't change. To use another group, delete this testbed and add a new one.",
} as const;

// What the edit dialog loads on open (AC-3): the only payload that carries a
// client's OS login, one testbed at a time.
export type TestbedEditDefaults = {
  readonly name: string;
  readonly groupName: string;
  readonly slug: string;
  readonly domain: string;
  readonly testbedTypeId: string;
  readonly idpApiKeyId: string | null;
  readonly portalUrl: string;
  readonly lmsUrl: string;
  readonly clients: readonly TestbedClientInput[];
};

export const clientCountLabel = (n: number) =>
  `${n} client${n === 1 ? "" : "s"}`;

// Spec 0018 AC-8: what the list's search matches. No IDP adds nothing, not
// the `—`.
export const testbedSearchText = (row: {
  readonly name: string;
  readonly groupName: string;
  readonly typeName: string;
  readonly domain: string;
  readonly idpName: string | null;
}) =>
  [row.name, row.groupName, row.typeName, row.domain, row.idpName]
    .filter((v) => v !== null)
    .join(" ");

const sameClient = (a: TestbedClientInput, b: TestbedClientInput) =>
  a.kind === b.kind &&
  a.name === b.name &&
  a.url === b.url &&
  a.osUsername === b.osUsername &&
  a.osPassword === b.osPassword;

// The ordered client lists match in every field.
export const sameClients = (
  a: readonly TestbedClientInput[],
  b: readonly TestbedClientInput[],
) => a.length === b.length && a.every((c, i) => sameClient(c, b[i] ?? c));

// The group name is not here: it never changes after create (spec 0018 AC-8).
const TESTBED_FIELDS = [
  "name",
  "testbedTypeId",
  "idpApiKeyId",
  "portalUrl",
  "lmsUrl",
  "domain",
] as const;

export type TestbedEditChange = {
  readonly clientsChanged: boolean;
  // The testbed.updated audit metadata (AC-5): field names, ids, URLs, and
  // client counts, never an OS username or password.
  readonly metadata: Readonly<Record<string, unknown>>;
};

// A testbed's editable values: the parsed form, or the row as stored.
export type TestbedValues = Omit<TestbedUpdateInput, "clients"> & {
  readonly clients: readonly TestbedClientInput[];
};

// AC-3 and AC-5: what an edit changes, or null when it changes nothing.
export function testbedEditChange(
  before: TestbedValues,
  after: TestbedValues,
): TestbedEditChange | null {
  const fields = changedFields(TESTBED_FIELDS, before, after);
  const clientsChanged = !sameClients(before.clients, after.clients);
  if (Object.keys(fields).length === 0 && !clientsChanged) return null;
  const accessChanged =
    clientsChanged || "portalUrl" in fields || "lmsUrl" in fields;
  return {
    clientsChanged,
    metadata: {
      ...fields,
      ...(clientsChanged
        ? {
            clients: {
              from: before.clients.length,
              to: after.clients.length,
            },
          }
        : {}),
      ...(accessChanged ? { accessChanged: true } : {}),
    },
  };
}
