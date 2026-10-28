import { ATTEMPTS, BACKOFF } from "./timing";

// Reply classification (spec 0023 AC-21), one pure function. Safe on both
// sides.
export type Verb = "delete" | "list" | "read" | "write";

export type Outcome =
  | {
      readonly kind: "reply";
      readonly status: number;
      readonly message: string;
    }
  | {
      readonly kind: "network" | "timeout" | "redirect" | "oversize";
    };

export type Expectations = {
  readonly okStatus?: readonly number[];
  readonly emptyOn?: readonly number[];
  readonly expectRefusals?: readonly {
    readonly status: number;
    readonly messageContains: string;
  }[];
};

// done: the call worked. gone: a delete found nothing. nothing: a list or
// read has nothing to do. expected: a refusal the step names. retry: try
// again if attempts remain. failed: record it. All but retry and failed are
// silent (AC-22).
export type Class =
  "done" | "gone" | "nothing" | "expected" | "retry" | "failed";

const isOk = (status: number, okStatus: readonly number[] | undefined) =>
  okStatus ? okStatus.includes(status) : status >= 200 && status < 300;

export function classify(
  verb: Verb,
  outcome: Outcome,
  expect: Expectations = {},
): Class {
  if (outcome.kind === "network" || outcome.kind === "timeout") return "retry";
  if (outcome.kind !== "reply") return "failed";
  const { status, message } = outcome;
  if (isOk(status, expect.okStatus)) return "done";
  if (verb === "delete" && status === 404) return "gone";
  if (
    (verb === "list" || verb === "read") &&
    (status === 404 || (expect.emptyOn ?? []).includes(status))
  ) {
    return "nothing";
  }
  const lower = message.toLowerCase();
  if (
    (expect.expectRefusals ?? []).some(
      (r) =>
        r.status === status && lower.includes(r.messageContains.toLowerCase()),
    )
  ) {
    return "expected";
  }
  if (status === 429 || status >= 500) return "retry";
  return "failed";
}

// After the `attempt`th try (1 based) of a call classed `retry`: the wait
// before the next try, or null when the attempts are used up.
export const retryDelay = (attempt: number): number | null =>
  attempt >= ATTEMPTS ? null : (BACKOFF[attempt - 1] ?? null);
