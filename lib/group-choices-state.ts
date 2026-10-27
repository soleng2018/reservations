import type { Result } from "@/lib/result";
import type { GroupChoice } from "@/lib/testbeds";

export type Loaded =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly choices: readonly GroupChoice[] }
  | { readonly kind: "unavailable" };

// `current` is the id of the open whose answer still counts, or null while the
// dialog is closed. Spec 0017 AC-18: only the latest open's answer counts, and
// the list is dropped on close.
export type ChoicesState = {
  readonly current: number | null;
  readonly loaded: Loaded;
};

export type ChoicesAction =
  | { readonly type: "open"; readonly id: number }
  | {
      readonly type: "answer";
      readonly id: number;
      // `null` when the call itself threw.
      readonly result: Result<readonly GroupChoice[], "unavailable"> | null;
    }
  | { readonly type: "closed" };

export const CHOICES_CLOSED: ChoicesState = {
  current: null,
  loaded: { kind: "loading" },
};

export const choicesReducer = (
  state: ChoicesState,
  action: ChoicesAction,
): ChoicesState => {
  switch (action.type) {
    case "open":
      return { current: action.id, loaded: { kind: "loading" } };
    case "closed":
      return CHOICES_CLOSED;
    case "answer":
      if (action.id !== state.current) return state;
      return {
        current: state.current,
        loaded:
          action.result?.ok === true
            ? { kind: "ready", choices: action.result.value }
            : { kind: "unavailable" },
      };
    default: {
      const never: never = action;
      return never;
    }
  }
};

// Spec 0017 AC-18, AC-22: the text under the select when the list is empty or
// no choice has a domain; undefined when there is nothing to say.
export const groupNoticeKey = (
  choices: readonly GroupChoice[],
): "groupChoicesEmpty" | "groupChoicesNoDomain" | undefined =>
  choices.length === 0
    ? "groupChoicesEmpty"
    : choices.every((c) => c.domain === null)
      ? "groupChoicesNoDomain"
      : undefined;
