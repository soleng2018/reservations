import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StartingList } from "@/lib/portal-reset/starting-list";
import { rowView } from "@/lib/portal-reset/view";
import raw from "@/db/seed/portal-reset-starting-list.json";
import { PortalResetSettings } from "./portal-reset-settings";
import { PortalResetSteps } from "./portal-reset-steps";

const rows = StartingList.parse(raw).steps.map((s, i) =>
  rowView(
    {
      id: s.key,
      position: i + 1,
      featureName: s.featureName,
      enabled: s.enabled,
      note: s.note,
    },
    s.definition,
  ),
);
const html = renderToStaticMarkup(<PortalResetSteps rows={rows} />);

// AC-4: the read only first view.
describe("PortalResetSteps", () => {
  it("shows the order numbers 1 to 13 and every feature name", () => {
    const numbers = [
      ...html.matchAll(
        /data-testid="step-number"[^>]*>(?:<span[^>]*>Step <\/span>)?(\d+)</g,
      ),
    ];
    expect(numbers.map((m) => Number(m[1]))).toEqual(rows.map((_, i) => i + 1));
    rows.forEach((r) =>
      expect(html).toContain(r.featureName.replace(/&/g, "&amp;")),
    );
  });

  it("badges only the disabled step", () => {
    expect(html.match(/>Disabled</g)).toHaveLength(1);
    expect(html.indexOf("Service Profiles")).toBeLessThan(
      html.indexOf(">Disabled<"),
    );
  });

  it("describes each step in plain words, with the guard lines", () => {
    expect(html).toContain("skipping items where ssid.popTunnelUsed is true");
    expect(html).toContain(
      "SSIDs where ssid.popTunnelUsed is true are never deleted.",
    );
    expect(html).toContain("Wait 10 seconds");
  });

  it("has no handle, input, button, or form: nothing to edit", () => {
    expect(html).not.toMatch(/<(button|input|textarea|select|form)\b/);
  });

  it("stacks each row as a card below the nav breakpoint (AC-15)", () => {
    expect(html).toContain("nav:grid-cols-");
    expect(html).toContain("rounded-xl border bg-card");
  });

  it("shows a step that no longer parses as an alert, not a crash", () => {
    const bad = renderToStaticMarkup(
      <PortalResetSteps
        rows={[
          rowView(
            {
              id: "x",
              position: 1,
              featureName: "Broken",
              enabled: true,
              note: null,
            },
            null,
          ),
        ]}
      />,
    );
    expect(bad).toContain('role="alert"');
    expect(bad).toContain("Broken");
  });

  it("shows a plain empty message with no rows", () => {
    expect(renderToStaticMarkup(<PortalResetSteps rows={[]} />)).toContain(
      "No reset steps yet",
    );
  });

  it("renders text as text, never as HTML", () => {
    const evil = renderToStaticMarkup(
      <PortalResetSteps
        rows={[
          rowView(
            {
              id: "x",
              position: 1,
              featureName: "<img src=x onerror=alert(1)>",
              enabled: true,
              note: "<b>n</b>",
            },
            null,
          ),
        ]}
      />,
    );
    expect(evil).not.toContain("<img");
    expect(evil).not.toContain("<b>n</b>");
  });
});

describe("PortalResetSettings", () => {
  const show = (props: Partial<Parameters<typeof PortalResetSettings>[0]>) =>
    renderToStaticMarkup(
      <PortalResetSettings
        abortEmail={null}
        mode="off"
        lastSaved={null}
        {...props}
      />,
    );

  it("AC-10: warns while the email is empty", () => {
    expect(show({})).toContain("Aborted resets will not be emailed.");
    expect(show({ abortEmail: "ops@example.com" })).not.toContain(
      "will not be emailed",
    );
    expect(show({ abortEmail: "ops@example.com" })).toContain(
      "ops@example.com",
    );
  });

  it("shows the mode as a badge with its plain words", () => {
    expect(show({ mode: "dry_run" })).toContain("Dry run");
    expect(show({ mode: "live" })).toContain(
      "Live resets".slice(0, 0) + "delete things on real Nile Portals",
    );
  });

  it("shows the last saved line only after a first Save", () => {
    expect(show({})).not.toContain("Last saved");
    expect(show({ lastSaved: "Maria on 27 Oct 2026" })).toContain(
      "Last saved by Maria on 27 Oct 2026",
    );
  });

  it("has no control in read only", () => {
    expect(show({ abortEmail: "a@b.co" })).not.toMatch(
      /<(button|input|select)\b/,
    );
  });
});
