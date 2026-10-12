import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LearnerFooter } from "./learner-footer";

const render = () => renderToStaticMarkup(createElement(LearnerFooter));

// Spec 0009 AC-5: the Nile sign off, last on every learner page.
describe("LearnerFooter", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  // covers: AC-5
  it("names Nile Hands-On Labs and links nilesecure.com in the same tab", () => {
    const html = render();
    expect(html).toContain("Nile Hands-On Labs · ");
    expect(html).toMatch(
      /<a href="https:\/\/www\.nilesecure\.com"[^>]*>nilesecure\.com<\/a>/,
    );
    expect(html).not.toContain("target=");
  });

  // covers: AC-5
  it("shows the copyright line with the current year", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-15T12:00:00Z"));
    expect(render()).toContain("Copyright © 2026 Nile. All rights reserved.");
  });

  // covers: AC-5, the UTC year, not the server's local year
  it("uses the UTC year when the server's zone is still on Dec 31", () => {
    vi.stubEnv("TZ", "America/Los_Angeles");
    vi.useFakeTimers({ toFake: ["Date"] });
    // 16:30 on Dec 31 in Los Angeles, already Jan 1 in UTC.
    vi.setSystemTime(new Date("2027-01-01T00:30:00Z"));
    expect(new Date().getFullYear()).toBe(2026);
    expect(render()).toContain("Copyright © 2027 Nile.");
  });

  it("is a footer landmark", () => {
    expect(render()).toMatch(/^<footer[\s>]/);
  });
});
