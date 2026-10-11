import type { TestbedClientInput, TestbedInput } from "./catalog-input";
import { changedFields } from "./changed-fields";

// Testbed admin (spec 0007), safe on both sides.

export const TESTBED_MESSAGES = {
  duplicateName: "A testbed with this name already exists.",
  typeGone: "That type no longer exists.",
  idpGone: "That IDP key no longer exists.",
  gone: "This testbed no longer exists.",
  notReady: "This testbed is still being set up. Try again in a minute.",
  groupFailed: "Couldn't create the testbed's access group, try again",
} as const;

// What the edit dialog loads on open (AC-3): the only payload that carries a
// client's OS login, one testbed at a time.
export type TestbedEditDefaults = {
  readonly name: string;
  readonly slug: string;
  readonly groupName: string;
  readonly testbedTypeId: string;
  readonly idpApiKeyId: string | null;
  readonly portalUrl: string;
  readonly lmsUrl: string;
  readonly clients: readonly TestbedClientInput[];
};

export const clientCountLabel = (n: number) =>
  `${n} client${n === 1 ? "" : "s"}`;

// AC-1: what the list's search matches. No IDP adds nothing, not the `—`.
export const testbedSearchText = (row: {
  readonly name: string;
  readonly typeName: string;
  readonly idpName: string | null;
}) => [row.name, row.typeName, row.idpName].filter((v) => v !== null).join(" ");

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

const TESTBED_FIELDS = [
  "name",
  "testbedTypeId",
  "idpApiKeyId",
  "portalUrl",
  "lmsUrl",
] as const;

export type TestbedEditChange = {
  readonly clientsChanged: boolean;
  // The testbed.updated audit metadata (AC-5): field names, ids, URLs, and
  // client counts, never an OS username or password.
  readonly metadata: Readonly<Record<string, unknown>>;
};

// A testbed's editable values: the parsed form, or the row as stored.
export type TestbedValues = Omit<TestbedInput, "clients"> & {
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
