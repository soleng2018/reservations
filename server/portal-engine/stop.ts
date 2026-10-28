import "server-only";
import type { PortalResetAbortReason } from "@/lib/db-enums";

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
