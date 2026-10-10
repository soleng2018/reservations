// Badge tones (spec 0005 *Contrast pairs*): each is an AA text pair.
export const BADGE_TONES = ["info", "success", "neutral", "accent"] as const;

export type BadgeTone = (typeof BADGE_TONES)[number];

// Status words from the mock, and the tone each one wears.
const TONE_OF: Readonly<Record<string, BadgeTone>> = {
  upcoming: "info",
  idp: "info",
  current: "success",
  active: "success",
  ai: "accent",
  past: "neutral",
  inactive: "neutral",
  cancelled: "neutral",
  "not ready": "neutral",
};

// The tone for a status word, case insensitive; unknown words are neutral.
export const toneFor = (word: string): BadgeTone =>
  TONE_OF[word.trim().toLowerCase()] ?? "neutral";
