import { beforeEach, describe, expect, it, vi } from "vitest";

// redirect() throws in Next.js; the mock throws too so the action stops there.
class Redirect extends Error {
  constructor(readonly to: string) {
    super(`redirect ${to}`);
  }
}

const signInSocial = vi.fn();
const appSignOut = vi.fn();
const currentSession = vi.fn();
const endAuthentikSessionsFor = vi.fn();
const steps: string[] = [];
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Redirect(to);
  },
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/server/auth", () => ({
  auth: () => ({ api: { signInSocial, signOut: appSignOut } }),
}));
vi.mock("@/server/auth/require", () => ({ currentSession }));
vi.mock("@/server/env", () => ({ adminEntryPath: () => "/l0gin" }));
vi.mock("@/server/auth/sign-out", async () => {
  const real = await vi.importActual<object>("@/server/auth/sign-out");
  return { ...real, endAuthentikSessionsFor };
});
vi.mock("server-only", () => ({}));

const { signInWithSso, signOut } = await import("./actions");

const redirectOf = async (action: () => Promise<never>) => {
  const thrown = await action().catch((e: unknown) => e);
  expect(thrown).toBeInstanceOf(Redirect);
  return (thrown as Redirect).to;
};
const redirectTarget = () => redirectOf(signInWithSso);

describe("signInWithSso", () => {
  beforeEach(() => {
    signInSocial.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("sends you to the Authentik authorize URL with the landing and error callbacks", async () => {
    signInSocial.mockResolvedValue({ url: "https://sso.test/authorize?x=1" });
    expect(await redirectTarget()).toBe("https://sso.test/authorize?x=1");
    expect(signInSocial).toHaveBeenCalledWith({
      body: expect.objectContaining({
        provider: "authentik",
        callbackURL: "/auth/landing",
        errorCallbackURL: "/auth/error",
        disableRedirect: true,
      }),
    });
  });

  // covers: AC-15
  it("shows the unavailable page when Authentik cannot be reached", async () => {
    signInSocial.mockRejectedValue(new Error("provider not found"));
    expect(await redirectTarget()).toBe("/auth/error?reason=unavailable");
  });

  // covers: AC-15
  it("shows the unavailable page when no authorize URL comes back", async () => {
    signInSocial.mockResolvedValue({ url: undefined });
    expect(await redirectTarget()).toBe("/auth/error?reason=unavailable");
  });
});

const sessionAs = (role: "admin" | "learner") => ({
  user: { id: `${role}-row`, role },
  session: { id: "s", authUserId: "a" },
});

describe("signOut", () => {
  beforeEach(() => {
    steps.length = 0;
    currentSession.mockReset();
    appSignOut.mockReset().mockImplementation(async () => {
      steps.push("app session");
    });
    endAuthentikSessionsFor.mockReset().mockImplementation(async () => {
      steps.push("authentik sessions");
      return true;
    });
  });

  // covers: AC-12
  it("sends a learner straight back to the landing page, app session first", async () => {
    currentSession.mockResolvedValue(sessionAs("learner"));
    expect(await redirectOf(signOut)).toBe("/");
    expect(steps).toEqual(["app session", "authentik sessions"]);
    expect(endAuthentikSessionsFor).toHaveBeenCalledWith("learner-row");
  });

  // covers: AC-12
  it("sends an admin straight back to the admin entry page", async () => {
    currentSession.mockResolvedValue(sessionAs("admin"));
    expect(await redirectOf(signOut)).toBe("/l0gin");
  });

  // covers: AC-12
  it("still ends the app session when Authentik can't be reached", async () => {
    currentSession.mockResolvedValue(sessionAs("learner"));
    endAuthentikSessionsFor.mockResolvedValue(false);
    expect(await redirectOf(signOut)).toBe(
      "/auth/error?reason=signout_partial",
    );
    expect(appSignOut).toHaveBeenCalledOnce();
  });

  it("does nothing without a session", async () => {
    currentSession.mockResolvedValue(undefined);
    expect(await redirectOf(signOut)).toBe("/");
    expect(appSignOut).not.toHaveBeenCalled();
    expect(endAuthentikSessionsFor).not.toHaveBeenCalled();
  });
});
