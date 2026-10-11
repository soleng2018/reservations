import { describe, expect, it } from "vitest";
import {
  ApiKeyCreateInput,
  ApiKeyUpdateInput,
  HttpsUrl,
  TestbedInput,
  TestbedTypeInput,
} from "./catalog-input";
import { fieldErrors } from "./form-errors";

const TYPE_ID = "6f1c2f9e-0000-4000-8000-000000000001";

const errorsOf = <T>(r: { success: boolean; error?: T }) => {
  if (r.success || !r.error)
    throw new Error("expected the input to be refused");
  return r.error;
};

// covers: AC-1 (the admin type form)
describe("TestbedTypeInput (AC-1)", () => {
  const valid = {
    name: "Wi-Fi 7 lab",
    durationValue: "2",
    durationUnit: "hours",
  };

  it("trims the name and coerces the duration from form text", () => {
    expect(
      TestbedTypeInput.parse({ ...valid, name: "  Wi-Fi 7 lab " }),
    ).toEqual({ name: "Wi-Fi 7 lab", durationValue: 2, durationUnit: "hours" });
  });

  it("refuses an empty name and a zero duration with the admin's messages", () => {
    const e = errorsOf(
      TestbedTypeInput.safeParse({ ...valid, name: "", durationValue: "0" }),
    );
    expect(fieldErrors(e)).toEqual({
      name: "Enter a name.",
      durationValue: "Use at least 1.",
    });
  });

  it("refuses a name made only of spaces", () => {
    const e = errorsOf(TestbedTypeInput.safeParse({ ...valid, name: "   " }));
    expect(fieldErrors(e)).toEqual({ name: "Enter a name." });
  });

  it("refuses a fractional or non numeric duration", () => {
    for (const durationValue of ["1.5", "two"])
      expect(
        fieldErrors(
          errorsOf(TestbedTypeInput.safeParse({ ...valid, durationValue })),
        ),
      ).toEqual({ durationValue: "Enter a whole number." });
  });

  it("allows the largest Postgres integer and refuses one more", () => {
    expect(
      TestbedTypeInput.safeParse({ ...valid, durationValue: "2147483647" })
        .success,
    ).toBe(true);
    expect(
      fieldErrors(
        errorsOf(
          TestbedTypeInput.safeParse({ ...valid, durationValue: "2147483648" }),
        ),
      ),
    ).toEqual({ durationValue: "That's too long." });
  });

  it("refuses a duration unit outside the CHECK list", () => {
    const e = errorsOf(
      TestbedTypeInput.safeParse({ ...valid, durationUnit: "fortnights" }),
    );
    expect(Object.keys(fieldErrors(e))).toEqual(["durationUnit"]);
  });
});

// covers: AC-2 (the admin testbed form)
describe("TestbedInput (AC-2)", () => {
  const valid = {
    name: "Bench 1",
    testbedTypeId: TYPE_ID,
    portalUrl: "https://portal.example.test",
    lmsUrl: "https://lms.example.test",
    clients: [
      { kind: "wired", name: "Wired 1", url: "https://w1.example.test" },
    ],
  };

  it("parses a testbed with its clients, and one with none", () => {
    expect(TestbedInput.parse(valid)).toEqual(valid);
    expect(TestbedInput.parse({ ...valid, clients: [] }).clients).toEqual([]);
  });

  it("refuses http and other non https URLs", () => {
    const e = errorsOf(
      TestbedInput.safeParse({
        ...valid,
        portalUrl: "http://portal.example.test",
        lmsUrl: "ftp://lms.example.test",
      }),
    );
    expect(fieldErrors(e)).toEqual({
      portalUrl: "Enter an https:// URL.",
      lmsUrl: "Enter an https:// URL.",
    });
  });

  it("refuses text that is not a URL at all", () => {
    const e = errorsOf(TestbedInput.safeParse({ ...valid, lmsUrl: "lms" }));
    expect(fieldErrors(e)).toEqual({ lmsUrl: "Enter an https:// URL." });
  });

  it("keys a bad client field by its position, so the form can mark that row", () => {
    const e = errorsOf(
      TestbedInput.safeParse({
        ...valid,
        clients: [
          valid.clients[0],
          { kind: "wireless", name: "", url: "http://a1.example.test" },
        ],
      }),
    );
    expect(fieldErrors(e)).toEqual({
      "clients.1.name": "Enter a name.",
      "clients.1.url": "Enter an https:// URL.",
    });
  });

  it("refuses a client kind outside the CHECK list", () => {
    const e = errorsOf(
      TestbedInput.safeParse({
        ...valid,
        clients: [{ ...valid.clients[0], kind: "satellite" }],
      }),
    );
    expect(Object.keys(fieldErrors(e))).toEqual(["clients.0.kind"]);
  });

  it("refuses a type id that is not a uuid", () => {
    const e = errorsOf(TestbedInput.safeParse({ ...valid, testbedTypeId: "" }));
    expect(fieldErrors(e)).toEqual({ testbedTypeId: "Choose a type." });
  });
});

// covers: spec 0006 AC-3 (the API key form)
describe("ApiKeyCreateInput and ApiKeyUpdateInput (spec 0006 AC-3)", () => {
  const valid = {
    name: " Okta Production ",
    type: "IDP",
    baseUrl: " https://acme.okta.com/oauth2 ",
    secret: "  tok_123  ",
  };

  it("trims every field, the key included", () => {
    expect(ApiKeyCreateInput.parse(valid)).toEqual({
      name: "Okta Production",
      type: "IDP",
      baseUrl: "https://acme.okta.com/oauth2",
      secret: "tok_123",
    });
  });

  it("requires the key on add and allows it blank on edit", () => {
    const blank = { ...valid, secret: "   " };
    expect(fieldErrors(errorsOf(ApiKeyCreateInput.safeParse(blank)))).toEqual({
      secret: "Enter the key.",
    });
    expect(
      fieldErrors(
        errorsOf(ApiKeyCreateInput.safeParse({ ...valid, secret: undefined })),
      ),
    ).toEqual({ secret: "Enter the key." });
    expect(ApiKeyUpdateInput.parse(blank).secret).toBe("");
  });

  it("caps the key at 4096 characters on add and edit", () => {
    const long = { ...valid, secret: "x".repeat(4097) };
    for (const schema of [ApiKeyCreateInput, ApiKeyUpdateInput])
      expect(fieldErrors(errorsOf(schema.safeParse(long)))).toEqual({
        secret: "Use at most 4096 characters.",
      });
    expect(
      ApiKeyCreateInput.parse({ ...valid, secret: "x".repeat(4096) }).secret,
    ).toHaveLength(4096);
  });

  it("never puts the key's value in an issue", () => {
    const long = "canary-".repeat(700);
    const e = errorsOf(ApiKeyCreateInput.safeParse({ ...valid, secret: long }));
    expect(JSON.stringify(e.issues)).not.toContain("canary");
  });

  it("refuses an unknown type", () => {
    const e = errorsOf(ApiKeyCreateInput.safeParse({ ...valid, type: "LLM" }));
    expect(fieldErrors(e)).toEqual({ type: "Choose a type." });
  });

  it.each([
    ["http://acme.okta.com", "Enter an https:// URL."],
    ["acme.okta.com", "Enter an https:// URL."],
    ["https://user:tok@acme.okta.com", "Remove credentials from the URL."],
    ["https://user@acme.okta.com", "Remove credentials from the URL."],
    ["https://acme.okta.com/?key=x", "Remove the query string from the URL."],
    [`https://a.example/${"p".repeat(2040)}`, "Use at most 2048 characters."],
  ])("refuses the base URL %s", (baseUrl, message) => {
    const e = errorsOf(ApiKeyCreateInput.safeParse({ ...valid, baseUrl }));
    expect(fieldErrors(e)).toEqual({ baseUrl: message });
  });

  it("refuses a duplicate name only in the database (not here)", () => {
    expect(
      ApiKeyCreateInput.safeParse({ ...valid, name: "OKTA" }).success,
    ).toBe(true);
  });
});

describe("HttpsUrl", () => {
  it("caps every catalog URL at 2048 characters", () => {
    expect(
      HttpsUrl.safeParse(`https://a.example/${"p".repeat(2040)}`).success,
    ).toBe(false);
    expect(HttpsUrl.safeParse("https://lms.example/course?id=7").success).toBe(
      true,
    );
  });
});
