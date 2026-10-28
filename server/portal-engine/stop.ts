import "server-only";
import type {
  PortalResetAbortReason,
  PortalResetSignInReason,
} from "@/lib/db-enums";

// Thrown by the interpreter's `beforeWrite` hook when the stop check says the
// run must end (spec 0023 AC-6). It is control flow inside one run, caught in
// `executeRun`; nothing outside the engine sees it. `lost` means another lane
// took the run over, so this one ends without writing a result.
export class StopRun extends Error {
  readonly reason: PortalResetAbortReason | "lost";

  constructor(reason: PortalResetAbortReason | "lost") {
    super(`portal reset run stopped: ${reason}`);
    this.name = "StopRun";
    this.reason = reason;
  }
}

// A path no call may use, or a write that would touch a protected item
// (spec 0023 AC-25, AC-26). Nothing was sent. `route` is a pattern with
// `{id}`, never a resolved URL. The run ends `guard_stop`.
export class GuardStop extends StopRun {
  readonly route: string;

  constructor(route: string) {
    super("guard_stop");
    this.name = "GuardStop";
    this.route = route;
  }
}

// A 401 the engine could not recover from (spec 0023 AC-17): the one fresh
// sign in did not help, or was refused. The run ends as a sign in failure
// with this closed reason.
export class SessionLost extends StopRun {
  readonly signInReason: PortalResetSignInReason;

  constructor(signInReason: PortalResetSignInReason) {
    super("sign_in_failed");
    this.name = "SessionLost";
    this.signInReason = signInReason;
  }
}

// The process was told to stop (SIGTERM or SIGINT): thrown by the same hook
// before the next write, after the call in flight has finished (spec 0023
// AC-10). The run goes back to the queue with its progress.
export class Shutdown extends Error {
  constructor() {
    super("portal reset run released for shutdown");
    this.name = "Shutdown";
  }
}
