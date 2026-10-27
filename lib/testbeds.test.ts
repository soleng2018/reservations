import { describe, expect, it } from "vitest";
import {
  clientCountLabel,
  sameClients,
  testbedEditChange,
  testbedSearchText,
  type TestbedValues,
} from "./testbeds";

const client = {
  kind: "wireless",
  name: "Air 1",
  url: "https://a1.example.test",
  osUsername: "lab",
  osPassword: "s3cret pass",
} as const;

const before: TestbedValues = {
  name: "Wireless Lab 1",
  testbedTypeId: "6f1c2f9e-0000-4000-8000-000000000001",
  idpApiKeyId: null,
  portalUrl: "https://portal.example.test",
  lmsUrl: "https://lms.example.test",
  clients: [client],
};

// covers: spec 0007 AC-1 (client count label), spec 0017 AC-8 (search text)
describe("list helpers (AC-1, spec 0017 AC-8)", () => {
  it.each([
    [0, "0 clients"],
    [1, "1 client"],
    [3, "3 clients"],
  ])("labels %i as %s", (n, label) => {
    expect(clientCountLabel(n)).toBe(label);
  });

  const row = {
    name: "Wireless Lab 1",
    groupName: "NileWorkshop1Admin",
    typeName: "Wi-Fi",
    domain: "nileworkshop-1.com",
    idpName: "Okta",
  };

  it("searches name, group name, type, domain, and IDP name, leaving out a missing IDP", () => {
    expect(testbedSearchText(row)).toBe(
      "Wireless Lab 1 NileWorkshop1Admin Wi-Fi nileworkshop-1.com Okta",
    );
    expect(testbedSearchText({ ...row, idpName: null })).toBe(
      "Wireless Lab 1 NileWorkshop1Admin Wi-Fi nileworkshop-1.com",
    );
  });

  it("never matches the dash shown for a missing IDP", () => {
    expect(testbedSearchText({ ...row, idpName: null })).not.toContain("—");
  });
});

// covers: spec 0007 AC-3 (no change skip), AC-5 (audit metadata)
describe("testbedEditChange (AC-3, AC-5)", () => {
  it("is null when nothing changed", () => {
    expect(testbedEditChange(before, { ...before, clients: [client] })).toBe(
      null,
    );
  });

  it("lists a changed name without an access change", () => {
    expect(testbedEditChange(before, { ...before, name: "Lab 2" })).toEqual({
      clientsChanged: false,
      metadata: { name: { from: "Wireless Lab 1", to: "Lab 2" } },
    });
  });

  it("marks a Portal or LMS URL change as an access change", () => {
    const portalUrl = "https://portal2.example.test";
    expect(testbedEditChange(before, { ...before, portalUrl })).toEqual({
      clientsChanged: false,
      metadata: {
        portalUrl: { from: before.portalUrl, to: portalUrl },
        accessChanged: true,
      },
    });
  });

  it.each([
    ["kind", { kind: "wired" }],
    ["name", { name: "Air 2" }],
    ["URL", { url: "https://a2.example.test" }],
    ["OS username", { osUsername: "admin" }],
    ["OS password", { osPassword: "other" }],
  ] as const)(
    "counts a client %s change, never with the credential",
    (_, patch) => {
      const change = testbedEditChange(before, {
        ...before,
        clients: [{ ...client, ...patch }],
      });
      expect(change).toEqual({
        clientsChanged: true,
        metadata: { clients: { from: 1, to: 1 }, accessChanged: true },
      });
      expect(JSON.stringify(change)).not.toMatch(/s3cret|lab|other|admin/);
    },
  );

  it("sees a reorder and a removal as a client change", () => {
    const two = { ...before, clients: [client, { ...client, name: "Air 2" }] };
    const swapped = { ...two, clients: [...two.clients].reverse() };
    expect(testbedEditChange(two, swapped)?.clientsChanged).toBe(true);
    expect(testbedEditChange(two, before)?.metadata).toEqual({
      clients: { from: 2, to: 1 },
      accessChanged: true,
    });
  });

  it("audits the type and IDP as ids, without an access change", () => {
    const idpApiKeyId = "6f1c2f9e-0000-4000-8000-000000000002";
    expect(testbedEditChange(before, { ...before, idpApiKeyId })).toEqual({
      clientsChanged: false,
      metadata: { idpApiKeyId: { from: null, to: idpApiKeyId } },
    });
  });

  it("puts a name change, an LMS change, and a client change in one metadata", () => {
    const lmsUrl = "https://lms2.example.test";
    expect(
      testbedEditChange(before, {
        ...before,
        name: "Lab 2",
        lmsUrl,
        clients: [],
      }),
    ).toEqual({
      clientsChanged: true,
      metadata: {
        name: { from: "Wireless Lab 1", to: "Lab 2" },
        lmsUrl: { from: before.lmsUrl, to: lmsUrl },
        clients: { from: 1, to: 0 },
        accessChanged: true,
      },
    });
  });
});

describe("sameClients", () => {
  it("compares the ordered lists field by field", () => {
    expect(sameClients([], [])).toBe(true);
    expect(sameClients([client], [{ ...client }])).toBe(true);
    expect(sameClients([client], [])).toBe(false);
    expect(sameClients([client], [{ ...client, osPassword: null }])).toBe(
      false,
    );
  });
});
