import { CheckIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { BOOK_HEADING_ID } from "./step-heading";

// The progress checklist (spec 0010 AC-8). Paced by the flow's timers, not
// by the saga's real steps; the last item ticks only on a booked reply.
export const PROGRESS_STEPS = [
  "Reserving your testbed",
  "Setting up your account",
  "Confirming your reservation",
] as const;

export function ProgressScreen({
  title = "Setting up your reservation",
  steps = PROGRESS_STEPS,
  ticks,
}: {
  readonly title?: string;
  readonly steps?: readonly string[];
  readonly ticks: number;
}) {
  return (
    <div role="status" aria-live="polite" className="text-center">
      <div
        aria-hidden="true"
        className="mx-auto mb-6.5 size-14 animate-spin rounded-full border-4 border-nile-blue-100 border-t-nile-blue [animation-duration:900ms]"
      />
      <h1
        id={BOOK_HEADING_ID}
        tabIndex={-1}
        className="mb-6 text-title font-semibold text-fg1"
      >
        {title}
      </h1>
      <ul className="flex flex-col gap-3 rounded-xl border bg-card p-5.5 text-left text-sm">
        {steps.map((step, i) => {
          const done = i < ticks;
          return (
            <li
              key={step}
              className={cn(
                "flex items-center gap-3",
                done ? "text-fg1" : "text-fg3",
              )}
            >
              {done ? (
                <CheckIcon
                  aria-hidden="true"
                  className="size-4.5 shrink-0 text-success-fg"
                />
              ) : (
                <span
                  aria-hidden="true"
                  className="size-4.5 shrink-0 rounded-full border-2 border-border-strong"
                />
              )}
              <span>
                {step}
                <span className="sr-only">{done ? ", done" : ", waiting"}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
