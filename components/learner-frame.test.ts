import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CurrentSession, currentSession } from "@/server/auth/require";
import { LearnerFrame } from "./learner-frame";

// The session read is the boundary: it needs the request headers and the DB.
vi.mock("@/server/auth/require", () => ({ currentSession: vi.fn() }));

const SESSION: CurrentSession = {
  user: {
    id: "00000000-0000-4000-8000-000000000001",
    role: "learner",
    status: "active",
    name: "Lee Learner",
    email: "lee@example.com",
    timezone: "UTC",
  },
  session: {
    id: "s1",
    expiresAt: new Date("2030-01-01T00:00:00Z"),
    authUserId: "a1",
  },
};

const render = async () =>
  renderToStaticMarkup(
    await LearnerFrame({ children: createElement("p", null, "page body") }),
  );

describe("LearnerFrame", () => {
  beforeEach(() => {
    vi.mocked(currentSession).mockResolvedValue(SESSION);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // covers: AC-17, a signed in user always gets the avatar menu
  it("shows the account menu with the user's initials when a session exists", async () => {
    const html = await render();
    expect(html).toContain('aria-label="Account menu for Lee Learner"');
    expect(html).toContain(">LL<");
    expect(currentSession).toHaveBeenCalledTimes(1);
  });

  // covers: AC-17, a visitor sees no menu
  it("shows no account menu when there is no session", async () => {
    vi.mocked(currentSession).mockResolvedValue(undefined);
    const html = await render();
    expect(html).not.toContain("Account menu");
    expect(html).not.toContain("Sign out");
  });

  // covers: AC-1 (spec 0009), the landing still loads when the session read fails
  it("renders as signed out when the session read throws", async () => {
    vi.mocked(currentSession).mockRejectedValue(new Error("db down"));
    const html = await render();
    expect(html).not.toContain("Account menu");
    expect(html).toContain("page body");
  });

  // covers: AC-5, AC-10, skip link first, one main, footer after it
  it("puts the skip link first, the page in main, and the footer last", async () => {
    const html = await render();
    // React hoists the logo's preload <link> (it lands in <head> on a page),
    // so check the first anchor rather than the first tag.
    expect(html.match(/<a [^>]*>[^<]*/)?.[0]).toMatch(
      /^<a href="#content"[^>]*>Skip to content$/,
    );
    expect(html.indexOf("Skip to content")).toBeLessThan(
      html.indexOf("<header"),
    );
    expect(html).toMatch(
      /<main id="content" tabindex="-1"[^>]*><p>page body<\/p><\/main><footer[\s>]/,
    );
    expect(html.match(/<main[\s>]/g)).toHaveLength(1);
    expect(html).toMatch(/<\/footer>$/);
  });
});
