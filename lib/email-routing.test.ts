import { describe, expect, it } from "vitest";
import { isTestAddress, routeEmail } from "./email-routing";

// covers: spec 0013 AC-16
describe("isTestAddress (spec 0013 AC-16)", () => {
  it.each([
    "dev-a@x.com",
    "DEV-Learner@Acme.com",
    "hol-test-learner@example.test",
    "a@b.invalid",
    "a@shop.example",
    "a@dev.localhost",
    "a@example.com",
    "a@EXAMPLE.org",
    "a@example.net",
  ])("treats %s as a test address", (a) => {
    expect(isTestAddress(a)).toBe(true);
  });

  it.each([
    "priya@acme.com",
    "developer@acme.com",
    "a@example.com.au",
    "a@notexample.com",
  ])("treats %s as real", (a) => {
    expect(isTestAddress(a)).toBe(false);
  });
});

describe("routeEmail (spec 0013 AC-16)", () => {
  it("sends a real address to itself with the Ops BCC", () => {
    expect(
      routeEmail("priya@acme.com", {
        devInbox: "dev@nile.co",
        opsBcc: "ops@nile.co",
      }),
    ).toEqual({
      kind: "send",
      to: "priya@acme.com",
      bcc: "ops@nile.co",
      subjectPrefix: "",
    });
  });

  it("reroutes a test address to the dev inbox with [dev] and no Bcc", () => {
    expect(
      routeEmail("dev-a@x.com", {
        devInbox: "dev@nile.co",
        opsBcc: "ops@nile.co",
      }),
    ).toEqual({
      kind: "send",
      to: "dev@nile.co",
      bcc: null,
      subjectPrefix: "[dev] ",
    });
  });

  it("suppresses a test address with no dev inbox", () => {
    expect(
      routeEmail("a@b.invalid", { devInbox: null, opsBcc: "ops@nile.co" }),
    ).toEqual({
      kind: "suppress",
      reason: "Test address and no dev inbox is set.",
    });
  });
});
