import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { toneFor } from "@/lib/badge-tones";
import type { BookingPhase } from "@/lib/booking-phase";

// One booking on the learner's list (spec 0011 AC-1), as in the mock: the
// testbed and its phase, the lab type, the times in the account zone, then
// the card's actions as rendered nodes.
export function ReservationCard({
  testbedName,
  phase,
  typeName,
  start,
  end,
  actions,
  note,
}: {
  readonly testbedName: string;
  readonly phase: BookingPhase;
  readonly typeName: string;
  readonly start: string;
  readonly end: string;
  readonly actions?: ReactNode;
  readonly note?: string;
}) {
  return (
    <li className="rounded-xl border bg-card px-5.5 py-5 shadow-xs">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-bold wrap-anywhere text-fg1">
          {testbedName}
        </h2>
        <Badge tone={toneFor(phase)}>{phase}</Badge>
      </div>
      <p className="mb-1 text-sub text-fg2">{typeName}</p>
      <p className="text-sub text-fg2">
        {start} → {end}
      </p>
      {actions ? (
        <div className="mt-4 flex flex-wrap items-center gap-2.5">
          {actions}
        </div>
      ) : null}
      {note ? <p className="mt-2.5 text-pill text-fg3">{note}</p> : null}
    </li>
  );
}
