import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TwoLoginsNotice } from "./two-logins-notice";

const render = (nileLogin: string | null, withSetPassword = true) =>
  renderToStaticMarkup(
    createElement(TwoLoginsNotice, { nileLogin, withSetPassword }),
  );

describe("two logins notice", () => {
  it("shows the window rule and the shared password", () => {
    const html = render(null);
    expect(html).toContain("Lab links work only during your window.");
    expect(html).toContain("two logins, one password");
    expect(html).toContain("Both use the same password");
  });

  it("shows the learner's real lab login when the booking has one", () => {
    const html = render("jane.doe@nileworkshop-1.com");
    expect(html).toContain("jane.doe@nileworkshop-1.com");
    expect(html).not.toContain("firstname.lastname@labdomain");
  });

  it("falls back to the pattern when there is no lab login", () => {
    expect(render(null)).toContain("firstname.lastname@labdomain");
  });

  it("drops the set password sentence for a learner who already has one", () => {
    expect(render(null)).toContain("link to set your password");
    expect(render(null, false)).not.toContain("link to set your password");
  });
});
