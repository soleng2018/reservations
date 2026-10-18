import { describe, expect, it } from "vitest";
import { isTestAddress, routeEmail, sameMailbox } from "./email-routing";

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

// covers: spec 0013 AC-35
describe("sameMailbox (spec 0013 AC-35)", () => {
  it.each([
    ["mnisdm@gmail.com", "mnisdm@gmail.com"],
    ["MNISDM@gmail.com", "mnisdm@gmail.com"],
    ["mnisdm+holops@gmail.com", "mnisdm@gmail.com"],
    ["M.Nisdm@googlemail.com", "mnisdm@gmail.com"],
    ["m.n.i.s.d.m+dev@GMAIL.COM", "mnisdm@gmail.com"],
    ["hol@ACME.com", "hol@acme.com"],
    ["hol+ops@acme.com", "hol@acme.com"],
    ["  hol@acme.com ", "hol@acme.com"],
  ])("puts %s in %s's mailbox", (a, b) => {
    expect(sameMailbox(a, b)).toBe(true);
    expect(sameMailbox(b, a)).toBe(true);
  });

  it.each([
    ["a.b@acme.com", "ab@acme.com"],
    ["hol@acme.com", "hol@acme.co"],
    ["mnisdm@gmail.com", "mnisdm@yahoo.com"],
    ["ops@nile.co", "mnisdm@gmail.com"],
  ])("keeps %s apart from %s", (a, b) => {
    expect(sameMailbox(a, b)).toBe(false);
  });
});

// covers: spec 0013 AC-16, AC-36
describe("routeEmail (spec 0013 AC-16, AC-36)", () => {
  const routing = {
    devInbox: "dev@nile.co",
    opsBcc: "ops@nile.co",
    senderEmail: "hol@nile.co",
  };

  it("sends a real address to itself with the Ops BCC", () => {
    expect(routeEmail("priya@acme.com", routing)).toEqual({
      kind: "send",
      to: "priya@acme.com",
      bcc: "ops@nile.co",
      subjectPrefix: "",
    });
  });

  it("reroutes a test address to the dev inbox with [dev] and no Bcc", () => {
    expect(routeEmail("dev-a@x.com", routing)).toEqual({
      kind: "send",
      to: "dev@nile.co",
      bcc: null,
      subjectPrefix: "[dev] ",
    });
  });

  it("suppresses a test address with no dev inbox", () => {
    expect(routeEmail("a@b.invalid", { ...routing, devInbox: null })).toEqual({
      kind: "suppress",
      reason: "Test address and no dev inbox is set.",
    });
  });

  it("drops an Ops BCC in the sender's mailbox and still sends", () => {
    expect(
      routeEmail("priya@acme.com", {
        ...routing,
        senderEmail: "mnisdm@gmail.com",
        opsBcc: "mnisdm+holops@gmail.com",
      }),
    ).toEqual({
      kind: "send",
      to: "priya@acme.com",
      bcc: null,
      subjectPrefix: "",
    });
  });

  it("sends a real address as usual when only the dev inbox clashes", () => {
    expect(
      routeEmail("priya@acme.com", {
        ...routing,
        senderEmail: "mnisdm@gmail.com",
        devInbox: "M.Nisdm@gmail.com",
      }),
    ).toEqual({
      kind: "send",
      to: "priya@acme.com",
      bcc: "ops@nile.co",
      subjectPrefix: "",
    });
  });

  it("suppresses a test address whose dev inbox is the sender's mailbox", () => {
    expect(
      routeEmail("dev-a@x.com", {
        ...routing,
        senderEmail: "mnisdm@gmail.com",
        devInbox: "mnisdm+dev@gmail.com",
      }),
    ).toEqual({
      kind: "suppress",
      reason: "The dev inbox is the sender's own mailbox.",
    });
  });

  it("leaves a learner whose own address is the sender's alone", () => {
    expect(
      routeEmail("mnisdm@gmail.com", {
        ...routing,
        senderEmail: "mnisdm@gmail.com",
      }),
    ).toEqual({
      kind: "send",
      to: "mnisdm@gmail.com",
      bcc: "ops@nile.co",
      subjectPrefix: "",
    });
  });
});
