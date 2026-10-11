import { describe, expect, it } from "vitest";
import { fieldErrors } from "./form-errors";
import { LearnerInput } from "./learner-input";

const valid = {
  name: "Priya Shah",
  company: "Concordia University",
  email: "priya@example.test",
  timezone: "America/Toronto",
};

const errorsFor = (input: unknown) => {
  const r = LearnerInput.safeParse(input);
  if (r.success) throw new Error("expected the input to be refused");
  return fieldErrors(r.error);
};

// An address of exactly `length` characters.
const emailOfLength = (length: number) => {
  const domain = "@example.test";
  return `${"a".repeat(length - domain.length)}${domain}`;
};

// covers: AC-4, AC-6 (the Add User and Edit User form, parsed on the server)
describe("LearnerInput (AC-4, AC-6)", () => {
  it("parses a valid form, trimming every text field", () => {
    expect(
      LearnerInput.parse({
        name: "  Priya Shah ",
        company: " Concordia University ",
        email: " priya@example.test ",
        timezone: " America/Toronto ",
      }),
    ).toEqual(valid);
  });

  it("keeps the email's case, since comparisons use lower()", () => {
    expect(
      LearnerInput.parse({ ...valid, email: "Priya.Shah@Example.TEST" }).email,
    ).toBe("Priya.Shah@Example.TEST");
  });

  it("names each missing field with its own message", () => {
    expect(errorsFor({})).toEqual({
      name: "Enter the full name.",
      company: "Enter the company name.",
      email: "Enter a valid email address.",
      timezone: "Choose a timezone from the list.",
    });
  });

  it("refuses a name and company made only of spaces", () => {
    expect(errorsFor({ ...valid, name: "   ", company: "\t" })).toEqual({
      name: "Enter the full name.",
      company: "Enter the company name.",
    });
  });

  it("allows 200 characters of name and company, and refuses 201", () => {
    const ok = "x".repeat(200);
    expect(
      LearnerInput.safeParse({ ...valid, name: ok, company: ok }).success,
    ).toBe(true);
    expect(errorsFor({ ...valid, name: `${ok}x`, company: `${ok}x` })).toEqual({
      name: "Enter the full name.",
      company: "Enter the company name.",
    });
  });

  it("refuses an email that is not an address", () => {
    for (const email of ["", "priya", "priya@", "@example.test", "a b@x.test"])
      expect(errorsFor({ ...valid, email })).toEqual({
        email: "Enter a valid email address.",
      });
  });

  it("allows a 254 character email and refuses 255", () => {
    expect(
      LearnerInput.safeParse({ ...valid, email: emailOfLength(254) }).success,
    ).toBe(true);
    expect(errorsFor({ ...valid, email: emailOfLength(255) })).toEqual({
      email: "Enter a valid email address.",
    });
  });

  it("refuses a timezone that is not on the list", () => {
    for (const timezone of ["Mars/Olympus_Mons", "", "x".repeat(101)])
      expect(errorsFor({ ...valid, timezone })).toEqual({
        timezone: "Choose a timezone from the list.",
      });
  });

  it("refuses values that are not strings without throwing", () => {
    expect(
      errorsFor({ name: 1, company: null, email: [], timezone: {} }),
    ).toEqual({
      name: "Enter the full name.",
      company: "Enter the company name.",
      email: "Enter a valid email address.",
      timezone: "Choose a timezone from the list.",
    });
  });
});
