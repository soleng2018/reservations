import type {
  PortalResetAbortReason,
  PortalResetItemKind,
  PortalResetRunState,
  PortalResetSignInReason,
} from "@/lib/db-enums";
import type { BadgeTone } from "@/lib/badge-tones";
import { ABORT_TEXT } from "./report-email";
import { SIGN_IN_TEXT } from "./sign-in";

// Words for the Recent resets pages (spec 0023 AC-32). Plain data in, plain
// words out; nothing here reads a portal value. Safe on both sides.

export const RUNS_PATH = "/admin/nile-portal-reset/runs";
export const RUNS_LIMIT = 50;
export const ITEMS_PAGE = 200;

const STATE_WORD: Readonly<Record<PortalResetRunState, string>> = {
  queued: "Waiting",
  running: "Running",
  held: "On hold",
  done: "Done",
  incomplete: "Incomplete",
  aborted: "Stopped",
};

export const stateWord = (state: PortalResetRunState): string =>
  STATE_WORD[state];

export const stateTone = (state: PortalResetRunState): BadgeTone =>
  state === "done"
    ? "success"
    : state === "queued" || state === "running"
      ? "info"
      : state === "held" || state === "incomplete"
        ? "accent"
        : "neutral";

// Why a run is not done, in a few words: the abort reason, or the sign in
// problem that holds or ended it.
export function reasonText(
  reason: PortalResetAbortReason | null,
  signIn: PortalResetSignInReason | null,
): string | null {
  const parts = [
    reason === null ? null : ABORT_TEXT[reason],
    signIn === null ? null : SIGN_IN_TEXT[signIn],
  ].filter((p): p is string => p !== null);
  return parts.length === 0 ? null : parts.join(" ");
}

const KIND_WORD: Readonly<Record<PortalResetItemKind, string>> = {
  deleted: "Deleted",
  changed: "Changed",
  failed: "Failed",
  would_delete: "Would delete",
  would_change: "Would change",
  route_found: "New route",
};

export const kindWord = (kind: PortalResetItemKind): string => KIND_WORD[kind];

export const kindTone = (kind: PortalResetItemKind): BadgeTone =>
  kind === "failed"
    ? "accent"
    : kind === "route_found"
      ? "info"
      : kind === "deleted" || kind === "changed"
        ? "success"
        : "neutral";

const num = (counts: Readonly<Record<string, number>>, key: string): number =>
  counts[key] ?? 0;

// The three numbers the list shows.
export const countsView = (counts: Readonly<Record<string, number>>) => ({
  deleted: num(counts, "deleted") + num(counts, "would_delete"),
  changed: num(counts, "changed") + num(counts, "would_change"),
  failed: num(counts, "failed"),
});

// 1 based page from the URL; anything else is the first page.
export const pageNumber = (raw: string | string[] | undefined): number => {
  const n = Number(Array.isArray(raw) ? raw[0] : raw);
  return Number.isInteger(n) && n >= 1 && n <= 10_000 ? n : 1;
};
