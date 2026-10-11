import { describe, expect, it } from "vitest";
import {
  cancelledByLabel,
  deactivatedToast,
  editDefaults,
  emailLockedHelper,
  learnerSearchText,
  learnerStatusLabel,
  reservationCountLabel,
} from "./learners";

// covers: AC-1 (list copy and search)
describe("users list copy (AC-1)", () => {
  it.each([
    [0, "0 reservations"],
    [1, "1 reservation"],
    [3, "3 reservations"],
  ])("labels %i as %s", (n, label) => {
    expect(reservationCountLabel(n)).toBe(label);
  });

  it("names the two statuses", () => {
    expect(learnerStatusLabel("active")).toBe("Active");
    expect(learnerStatusLabel("deactivated")).toBe("Deactivated");
  });

  it("searches over name, company, and email", () => {
    expect(
      learnerSearchText({
        name: "Priya Shah",
        company: "Concordia University",
        email: "priya@example.test",
      }),
    ).toBe("Priya Shah Concordia University priya@example.test");
  });

  it("adds nothing for a learner with no company", () => {
    expect(
      learnerSearchText({
        name: "Priya Shah",
        company: null,
        email: "priya@example.test",
      }),
    ).toBe("Priya Shah priya@example.test");
  });
});

// covers: AC-2 (the line under a Cancelled badge)
describe("cancelledByLabel (AC-2)", () => {
  it.each(["learner", "admin", "deactivation"] as const)(
    "says who cancelled: %s",
    (source) => {
      expect(cancelledByLabel(source)).toBe(`by ${source}`);
    },
  );
});

// covers: AC-6 (the edit dialog)
describe("edit dialog (AC-6)", () => {
  it("starts from the row's values", () => {
    const row = {
      name: "Priya Shah",
      company: "Concordia University",
      email: "priya@example.test",
      timezone: "America/Toronto",
      emailEditable: false,
    };
    expect(editDefaults(row)).toEqual(row);
  });

  it("shows an empty company for an older row that has none", () => {
    expect(
      editDefaults({
        name: "Priya Shah",
        company: null,
        email: "priya@example.test",
        timezone: "UTC",
        emailEditable: true,
      }).company,
    ).toBe("");
  });

  it("names the learner by first name under a locked email", () => {
    expect(emailLockedHelper("  Priya Anne Shah ")).toBe(
      "Priya has signed in, so their email can't change here.",
    );
  });
});

// covers: AC-8 (the toast after a deactivation)
describe("deactivatedToast (AC-8)", () => {
  it("says only the name when nothing was cancelled", () => {
    expect(deactivatedToast("Priya Shah", 0)).toBe("Deactivated Priya Shah.");
  });

  it("counts one cancelled reservation in the singular", () => {
    expect(deactivatedToast("Priya Shah", 1)).toBe(
      "Deactivated Priya Shah and cancelled 1 reservation.",
    );
  });

  it("counts several cancelled reservations in the plural", () => {
    expect(deactivatedToast("Priya Shah", 3)).toBe(
      "Deactivated Priya Shah and cancelled 3 reservations.",
    );
  });
});
