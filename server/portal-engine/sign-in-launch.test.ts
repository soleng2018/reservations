import { beforeEach, describe, expect, it, vi } from "vitest";

const launch = vi.hoisted(() => vi.fn());
vi.mock("playwright-core", () => ({ chromium: { launch } }));
vi.mock("server-only", () => ({}));

import { secret } from "./secret";
import { signIn } from "./sign-in";

const input = {
  origin: "https://portal.example.test",
  username: "u",
  password: secret("p"),
};

describe("signIn default browser launch (spec 0023, AC-10)", () => {
  beforeEach(() => {
    launch.mockReset();
    launch.mockRejectedValue(new Error("no browser"));
  });

  it("keeps Playwright from closing the browser on SIGINT, SIGTERM, and SIGHUP", async () => {
    await signIn(input);
    expect(launch).toHaveBeenCalledWith({
      headless: true,
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    });
  });

  it("answers browser_unavailable when the launch fails", async () => {
    expect(await signIn(input)).toEqual({
      ok: false,
      error: "browser_unavailable",
    });
  });
});
