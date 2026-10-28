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
