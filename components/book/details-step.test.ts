import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DetailsFields } from "@/app/book/actions";
import type { SelectOption } from "@/components/form-select";
import type { DetailsNotice } from "@/lib/booking-flow";
import type { FieldErrors } from "@/lib/form-errors";
import { DetailsStep } from "./details-step";

const TYPES: readonly SelectOption[] = [
  { value: "8d0b8f4e-6a52-4c1e-9d55-1a2b3c4d5e6f", label: "Basic · 4 hours" },
];

const FORM: DetailsFields = {
  name: "Priya Shah",
  company: "Acme University",
  email: "priya@example.test",
  timezone: "America/New_York",
  testbedTypeId: TYPES[0]?.value ?? "",
};

const render = ({
  types = TYPES,
  fields = {},
  notice = { kind: "none" },
  checking = false,
}: {
  readonly types?: readonly SelectOption[];
  readonly fields?: FieldErrors;
  readonly notice?: DetailsNotice;
  readonly checking?: boolean;
} = {}) =>
  renderToStaticMarkup(
    createElement(DetailsStep, {
      types,
      zones: ["America/New_York", "UTC"],
      form: FORM,
      fields,
      notice,
      checking,
      onEdit: () => {},
      onContinue: () => {},
    }),
  );

const NO_LABS =
  "No labs are open for booking right now. Please check back soon.";

// covers: spec 0010 AC-1
describe("DetailsStep with no bookable type (AC-1)", () => {
  it("says no labs are open", () => {
    const html = render({ types: [] });
    expect(html).toContain("Tell us about you");
    expect(html).toContain(NO_LABS);
  });

  it("shows no fields and no Continue, only Back to the home page", () => {
    const html = render({ types: [] });
    expect(html).not.toContain('name="name"');
    expect(html).not.toContain('name="email"');
    expect(html).not.toContain("Continue");
    expect(html).toContain('href="/"');
    expect(html).toContain("Back");
  });
});

// covers: spec 0010 AC-1
describe("DetailsStep with bookable types (AC-1)", () => {
  it("shows the five fields, Back to the home page, and Continue", () => {
    const html = render();
    for (const label of [
      "Full name",
      "Company name",
      "Email address",
      "Lab type",
      "Your timezone",
    ])
      expect(html).toContain(label);
    expect(html).toContain('href="/"');
    expect(html).toContain("Continue");
    expect(html).not.toContain(NO_LABS);
  });
});

// covers: spec 0010 AC-3
describe("DetailsStep notices (AC-3)", () => {
  it("shows the active reservation panel with its link to manage it", () => {
    const html = render({ notice: { kind: "has_live_booking" } });
    expect(html).toContain("You already have an active reservation");
    expect(html).toContain("Sign in to manage it.");
    expect(html).toContain('href="/reservations"');
    expect(html).toContain("Manage my reservations");
  });

  it("shows an alert's message", () => {
    const html = render({
      notice: {
        kind: "alert",
        message: "This email can't be used for booking.",
      },
    });
    expect(html).toContain("This email can&#x27;t be used for booking.");
    expect(html).not.toContain("You already have an active reservation");
  });

  it("shows no panel or alert when there is no notice", () => {
    const html = render();
    expect(html).not.toContain("You already have an active reservation");
    expect(html).not.toContain('role="alert"');
  });

  it("puts the type unavailable message under Lab type", () => {
    const html = render({ notice: { kind: "type_unavailable" } });
    expect(html).toContain(
      "That lab type is no longer available. Please pick another.",
    );
  });

  it("prefers a Lab type field error over the type unavailable message", () => {
    const html = render({
      fields: { testbedTypeId: "Choose a lab type." },
      notice: { kind: "type_unavailable" },
    });
    expect(html).toContain("Choose a lab type.");
    expect(html).not.toContain("That lab type is no longer available.");
  });
});

// covers: spec 0010 AC-2
describe("DetailsStep while the check runs (AC-2)", () => {
  it("disables Continue", () => {
    const html = render({ checking: true });
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""/);
  });

  it("enables Continue otherwise", () => {
    const html = render();
    expect(html).not.toMatch(/<button[^>]*type="submit"[^>]*disabled=""/);
  });
});
