import { describe, expect, it } from "vitest";
import {
  endedRows,
  labAccessView,
  labCardRows,
  labRows,
  SUCCESS_NOTE,
  type LabLinks,
} from "./lab-access";

const LINKS: LabLinks = {
  portalUrl: "https://portal.example.test",
  lmsUrl: "https://lms.example.test",
  clients: [
    { name: "Client A", kind: "wired", url: "https://a.example.test" },
    { name: "Client B", kind: "wireless", url: "https://b.example.test" },
  ],
};

// covers: AC-2, AC-7, AC-8
describe("labRows", () => {
  it("puts the portal and the LMS first, then each client in order", () => {
    expect(labRows(LINKS)).toEqual([
      { label: "Nile Portal", kind: null, url: LINKS.portalUrl },
      { label: "LMS course", kind: null, url: LINKS.lmsUrl },
      { label: "Client A", kind: "wired", url: "https://a.example.test" },
      { label: "Client B", kind: "wireless", url: "https://b.example.test" },
    ]);
  });

  it("drops every URL from ended rows", () => {
    const rows = endedRows(LINKS);
    expect(rows.map((r) => r.label)).toEqual([
      "Nile Portal",
      "LMS course",
      "Client A",
      "Client B",
    ]);
    expect(JSON.stringify(rows)).not.toContain("https://");
  });
});

// covers: AC-7, AC-8
describe("labAccessView", () => {
  it("is active with the support note while Current", () => {
    expect(labAccessView("Current")).toEqual({
      note: "Quote the testbed name below if you contact support. Access can take up to a minute to start after your start time.",
      active: true,
    });
  });

  it("is active with the start note while Upcoming", () => {
    expect(labAccessView("Upcoming")).toEqual({
      note: "These links start working at your start time (allow up to a minute). Quote the testbed name below if you contact support.",
      active: true,
    });
  });

  it("is ended once Past", () => {
    expect(labAccessView("Past")).toEqual({
      note: "This reservation has ended and access is no longer active. Quote the testbed name below if you contact support.",
      active: false,
    });
  });

  it.each(["Pending", "Cancelled"] as const)("throws for %s", (phase) => {
    expect(() => labAccessView(phase)).toThrow();
  });

  it("gives the success screens the start note alone", () => {
    expect(SUCCESS_NOTE).toBe(
      "These links start working at your start time (allow up to a minute).",
    );
  });
});

// covers: AC-8
describe("labCardRows", () => {
  it("gives links while active and labels only once ended", () => {
    expect(labCardRows(LINKS, labAccessView("Current")).kind).toBe("active");
    const ended = labCardRows(LINKS, labAccessView("Past"));
    expect(ended.kind).toBe("ended");
    expect(JSON.stringify(ended)).not.toContain("https://");
  });
});
