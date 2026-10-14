import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  labAccessView,
  labCardRows,
  SUCCESS_NOTE,
  type LabLinks,
} from "@/lib/lab-access";
import { LabAccessCard } from "./lab-access-card";

const LINKS: LabLinks = {
  portalUrl: "https://portal.example.test",
  lmsUrl: "https://lms.example.test",
  clients: [{ name: "Client A", kind: "wired", url: "https://a.example.test" }],
};
const URLS = [LINKS.portalUrl, LINKS.lmsUrl, "https://a.example.test"];

const detail = (phase: "Current" | "Upcoming" | "Past") => {
  const view = labAccessView(phase);
  return renderToStaticMarkup(
    createElement(LabAccessCard, {
      variant: "detail",
      note: view.note,
      rows: labCardRows(LINKS, view),
      testbedName: "aa bench",
    }),
  );
};

// covers: AC-2, AC-7
describe("LabAccessCard while active", () => {
  it("opens each link in a new tab without an opener or referrer", () => {
    const html = renderToStaticMarkup(
      createElement(LabAccessCard, {
        variant: "success",
        note: SUCCESS_NOTE,
        rows: labCardRows(LINKS, labAccessView("Upcoming")),
      }),
    );
    expect(html).toContain("Your lab access");
    expect(html).toContain(
      "These links start working at your start time (allow up to a minute).",
    );
    expect(html).toContain("Nile Portal");
    expect(html).toContain("LMS course");
    expect(html).toContain("Client A");
    expect(html).toContain("· wired");
    expect(html.match(/<a /g)).toHaveLength(3);
    expect(html.match(/target="_blank"/g)).toHaveLength(3);
    expect(html.match(/rel="noopener noreferrer"/g)).toHaveLength(3);
    for (const url of URLS) expect(html).toContain(`href="${url}"`);
    expect(html).not.toContain("Testbed assigned");
  });

  it("shows the testbed row and the Current note on the detail page", () => {
    const html = detail("Current");
    expect(html).toContain("Lab access");
    expect(html).toContain("Testbed assigned");
    expect(html).toContain("aa bench");
    expect(html).toContain("Access can take up to a minute");
  });
});

// covers: AC-8
describe("LabAccessCard once Past", () => {
  it("shows Ended tags with no anchor, no URL, and nothing focusable", () => {
    const html = detail("Past");
    expect(html).toContain(
      "This reservation has ended and access is no longer active.",
    );
    expect(html.match(/>Ended</g)).toHaveLength(3);
    expect(html).toContain("Nile Portal");
    expect(html).toContain("Client A");
    expect(html).not.toContain("<a");
    expect(html).not.toContain("href");
    expect(html).not.toContain("tabindex");
    expect(html).not.toContain("<button");
    for (const url of URLS) expect(html).not.toContain(url);
    expect(html).not.toContain("opacity");
  });
});
