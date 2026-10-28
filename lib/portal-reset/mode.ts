import type { BadgeTone } from "@/lib/badge-tones";
import type { PortalResetMode } from "@/lib/db-enums";

// The reset mode in plain words (spec 0022 AC-22). Safe on both sides.
export const MODE_LABEL = {
  off: "Off",
  dry_run: "Dry run",
  live: "Live",
} as const satisfies Record<PortalResetMode, string>;

export const MODE_TONE = {
  off: "neutral",
  dry_run: "info",
  live: "accent",
} as const satisfies Record<PortalResetMode, BadgeTone>;

export const MODE_HELP = {
  off: "Resets do not run.",
  dry_run:
    "Resets read the portal and report what they would delete, but delete nothing.",
  live: "Resets delete things on real Nile Portals after every lab.",
} as const satisfies Record<PortalResetMode, string>;

export const NO_EMAIL_WARNING = "Aborted resets will not be emailed.";
