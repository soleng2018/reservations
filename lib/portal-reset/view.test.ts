import { describe, expect, it } from "vitest";
import { BADGE_TONES } from "@/lib/badge-tones";
import { PortalResetMode } from "@/lib/db-enums";
import { MODE_HELP, MODE_LABEL, MODE_TONE } from "./mode";
import { StepDefinition } from "./step-schema";
import { rowView } from "./view";

const step = {
  id: "7d444840-9dc0-4c19-9d6e-0a1b2c3d4e5f",
  position: 3,
  featureName: "Remove SSIDs",
  enabled: true,
  note: null,
};

describe("rowView (AC-4, AC-20, AC-24)", () => {
  it("marks a row whose definition no longer parses as invalid, with no text", () => {
    const view = rowView(step, null);
    expect(view.invalid).toBe(true);
    expect(view.description).toEqual([]);
    expect(view.guardLines).toEqual([]);
    expect(view).toMatchObject({ id: step.id, position: 3, enabled: true });
  });

  it("describes a valid definition in plain sentences", () => {
    const definition = StepDefinition.parse({
      parts: [
        {
          kind: "delete_each",
          list: {
            method: "GET",
            path: "/api/v1/settings/ssids",
            itemsAt: "data.content",
            idField: "id",
          },
          delete: { path: "/api/v1/settings/ssids/{id}" },
          skipWhen: [{ field: "ssid.popTunnelUsed", op: "eq", value: true }],
        },
      ],
    });
    const view = rowView({ ...step, note: "n" }, definition);
    expect(view.invalid).toBe(false);
    expect(view.note).toBe("n");
    expect(view.description).toHaveLength(1);
    expect(view.description[0]).toContain("/api/v1/settings/ssids");
  });
});

describe("mode words", () => {
  it("covers every mode with a label, a help line, and a real badge tone", () => {
    PortalResetMode.options.forEach((mode) => {
      expect(MODE_LABEL[mode]).not.toBe("");
      expect(MODE_HELP[mode]).not.toBe("");
      expect(BADGE_TONES).toContain(MODE_TONE[mode]);
    });
  });
});
