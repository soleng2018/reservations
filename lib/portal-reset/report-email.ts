import type {
  PortalResetAbortReason,
  PortalResetEvent,
  PortalResetRunMode,
  PortalResetSignInReason,
} from "@/lib/db-enums";

// What the reset report email says (spec 0023 AC-31). Plain data built by the
// handler from the run and its saved item records at send time; every text
// here is redacted already (AC-30). Safe on both sides.

export type ReportFailure = {
  readonly stepKey: string;
  readonly label: string | null;
  readonly method: string | null;
  readonly route: string | null;
  readonly status: number | null;
  readonly message: string | null;
};

export type ReportRoute = {
  readonly route: string | null;
  readonly outcome: string;
  readonly found: number;
  readonly deleted: number;
  readonly left: number;
};

export type ResetReport = {
  readonly testbedName: string;
  readonly domain: string;
  readonly event: PortalResetEvent;
  readonly mode: PortalResetRunMode;
  // `held`: the sign in failed in a way a retry cannot fix, so the run waits
  // (spec 0023 AC-14).
  readonly outcome: "incomplete" | "aborted" | "done" | "held";
  readonly reason: PortalResetAbortReason | null;
  readonly signInReason: PortalResetSignInReason | null;
  readonly labEndedAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly counts: Readonly<Record<string, number>>;
  readonly failures: readonly ReportFailure[];
  // Failures past the 25 the email lists.
  readonly moreFailures: number;
  readonly routes: readonly ReportRoute[];
};

export const MAX_REPORT_FAILURES = 25;
export const MAX_REPORT_ROUTES = 20;

export const ABORT_TEXT: Readonly<Record<PortalResetAbortReason, string>> = {
  mode_off: "The reset mode was switched off.",
  sign_in_failed: "The reset could not sign in to the portal.",
  tenant_mismatch:
    "The portal tenant did not match the testbed's domain, so nothing was changed.",
  guard_stop:
    "A safety rule stopped the reset before a protected item or a forbidden route was touched.",
  lab_started:
    "A lab started on this testbed, so the reset stopped and the testbed was not fully reset.",
  deadline: "The reset ran past its 2 hour limit and was stopped.",
  testbed_unavailable:
    "The testbed was deleted or has no valid domain or portal address.",
  invalid_list:
    "A step in the reset list could not be read, so nothing was run.",
  crashed: "The reset was interrupted 3 times and was stopped.",
};

export const reportSubject = (r: ResetReport): string =>
  `Portal reset ${
    r.outcome === "aborted"
      ? "stopped"
      : r.outcome === "held"
        ? "is waiting"
        : r.outcome === "incomplete"
          ? "did not finish"
          : "found something new"
  }: ${r.testbedName}`;
