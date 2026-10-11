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
  name: "Bench 1",
  testbedTypeId: "6f1c2f9e-0000-4000-8000-000000000001",
  idpApiKeyId: null,
  portalUrl: "https://portal.example.test",
  lmsUrl: "https://lms.example.test",
  clients: [client],
};

// covers: spec 0007 AC-1 (client count label, search text)
describe("list helpers (AC-1)", () => {
  it.each([
    [0, "0 clients"],
    [1, "1 client"],
    [3, "3 clients"],
  ])("labels %i as %s", (n, label) => {
    expect(clientCountLabel(n)).toBe(label);
  });

  it("searches name, type, and IDP name, leaving out a missing IDP", () => {
    expect(
      testbedSearchText({ name: "Bench", typeName: "Wi-Fi", idpName: "Okta" }),
    ).toBe("Bench Wi-Fi Okta");
    expect(
      testbedSearchText({ name: "Bench", typeName: "Wi-Fi", idpName: null }),
    ).toBe("Bench Wi-Fi");
  });
});

// covers: spec 0007 AC-3 (no change skip), AC-5 (audit metadata)
describe("testbedEditChange (AC-3, AC-5)", () => {
  it("is null when nothing changed", () => {
    expect(testbedEditChange(before, { ...before, clients: [client] })).toBe(
      null,
    );
  });

  it("lists a renamed testbed's name without an access change", () => {
    expect(testbedEditChange(before, { ...before, name: "Bench 2" })).toEqual({
      clientsChanged: false,
      metadata: { name: { from: "Bench 1", to: "Bench 2" } },
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
