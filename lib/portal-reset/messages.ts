// What a refused Save says (spec 0022 AC-11). Plain words, no database text.
export const SAVE_MESSAGES = {
  stale:
    "Someone else saved the reset list after you opened it. Reload to see their changes. Your draft stays here until you reload.",
  unknown_step:
    "A step in your list was removed by someone else. Reload and try again.",
  duplicate_step:
    "A step appears twice in your list, or a starting list step was already added.",
  bad_seed_key: "A step added from the starting list is not in the file.",
  duplicate_name: "Two steps have the same name. Give each step its own name.",
} as const;

// The refusals a Save can return besides field errors.
export type SaveRefusalKind = keyof typeof SAVE_MESSAGES;
