import { describe, expect, it } from "vitest";
import { BookInput } from "./booking-input";
import { fieldErrors } from "./form-errors";

const TYPE_ID = "6f1c2f9e-0000-4000-8000-000000000001";

const valid = {
  name: "Ada Lovelace",
  company: "Analytical Engines",
  email: "ada@example.test",
  timezone: "America/St_Johns",
  testbedTypeId: TYPE_ID,
  startsAt: "2026-10-13T13:30:00.000Z",
};

const errorsFor = (input: unknown) => {
  const r = BookInput.safeParse(input);
  if (r.success) throw new Error("expected the input to be refused");
  return fieldErrors(r.error);
};

// covers: AC-3, AC-4 (the Step 1 form, parsed on the server)
describe("BookInput (AC-3, AC-4)", () => {
  it("parses a valid form, trimming text and turning the start into a Date", () => {
    const r = BookInput.parse({
      ...valid,
      name: "  Ada Lovelace  ",
      email: " ada@example.test ",
    });
    expect(r).toEqual({
      ...valid,
      startsAt: new Date("2026-10-13T13:30:00.000Z"),
    });
  });

  it("accepts a timezone alias such as Asia/Calcutta", () => {
    expect(
      BookInput.safeParse({ ...valid, timezone: "Asia/Calcutta" }).success,
    ).toBe(true);
  });

  it("names each missing field in plain words", () => {
    expect(errorsFor({})).toEqual({
      name: "Enter your name.",
      company: "Enter your company.",
      email: "Enter your email.",
      timezone: "Choose a timezone.",
      testbedTypeId: "Choose a lab type.",
      startsAt: "Choose a start time.",
    });
  });

  it("refuses name and company made only of spaces", () => {
    expect(errorsFor({ ...valid, name: "   ", company: "\t" })).toEqual({
      name: "Enter your name.",
      company: "Enter your company.",
    });
  });

  it("allows 200 characters of name and refuses 201", () => {
    expect(
      BookInput.safeParse({ ...valid, name: "a".repeat(200) }).success,
    ).toBe(true);
    expect(errorsFor({ ...valid, name: "a".repeat(201) })).toEqual({
      name: "Use at most 200 characters.",
    });
  });

  it("refuses a malformed email", () => {
    expect(errorsFor({ ...valid, email: "not an email" })).toEqual({
      email: "Enter a valid email address.",
    });
  });

  it("refuses an email longer than 254 characters", () => {
    const long = `${"a".repeat(64)}@${"b".repeat(186)}.test`;
    expect(long).toHaveLength(256);
    expect(errorsFor({ ...valid, email: long })).toEqual({
      email: "Use at most 254 characters.",
    });
  });

  it("refuses a timezone Intl does not know", () => {
    expect(errorsFor({ ...valid, timezone: "Mars/Olympus_Mons" })).toEqual({
      timezone: "Choose a timezone from the list.",
    });
  });

  it("refuses a type id that is not a uuid", () => {
    expect(errorsFor({ ...valid, testbedTypeId: "lab-1" })).toEqual({
      testbedTypeId: "Choose a lab type.",
    });
  });

  it("refuses a start that is not an ISO date time", () => {
    for (const startsAt of ["2026-10-13", "tomorrow at 9", ""])
      expect(errorsFor({ ...valid, startsAt })).toEqual({
        startsAt: "Choose a start time.",
      });
  });
});
