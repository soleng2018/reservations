import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Rescheduled } from "@/lib/reschedule-flow";
import { RescheduleSuccess } from "./reschedule-success";

const DONE: Rescheduled = {
  kind: "rescheduled",
  testbedName: "aa bench",
  typeName: "Basic",
  startsAt: "2026-10-13T13:00:00.000Z",
  endsAt: "2026-10-13T15:00:00.000Z",
  access: null,
};

const render = (done: Rescheduled) =>
  renderToStaticMarkup(
    createElement(RescheduleSuccess, { done, timezone: "America/New_York" }),
  );

// covers: spec 0012 AC-5
describe("RescheduleSuccess lab access (spec 0012 AC-5)", () => {
  it("shows the moved booking's lab access card", () => {
    const html = render({
      ...DONE,
      access: {
        portalUrl: "https://portal.example.test",
        lmsUrl: "https://lms.example.test",
        clients: [],
      },
    });
    expect(html).toContain("Your reservation has been rescheduled.");
    expect(html).toContain("Your lab access");
    expect(html).toContain('href="https://portal.example.test"');
    expect(html).toContain('href="https://lms.example.test"');
  });

  it("renders the rest of the screen without the card when there are no links", () => {
    const html = render(DONE);
    expect(html).toContain("Your reservation has been rescheduled.");
    expect(html).toContain("aa bench");
    expect(html).toContain("Done");
    expect(html).not.toContain("Your lab access");
    expect(html).not.toContain("https://");
  });
});
