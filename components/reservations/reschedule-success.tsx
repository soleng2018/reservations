import Link from "next/link";
import { CheckIcon } from "lucide-react";
import { BOOK_HEADING_ID } from "@/components/book/step-heading";
import { buttonVariants } from "@/components/ui/button";
import { formatDateTime } from "@/lib/format-time";
import type { Rescheduled } from "@/lib/reschedule-flow";
import { cn } from "@/lib/utils";

// The reschedule success card (spec 0011 AC-11), from the rescheduled reply
// in the account zone. No calendar invite line, Add to calendar, View email
// (feature 15), or lab links (feature 14) yet.
export function RescheduleSuccess({
  done,
  timezone,
}: {
  readonly done: Rescheduled;
  readonly timezone: string;
}) {
  const rows = [
    ["Testbed", done.testbedName],
    ["Lab type", done.typeName],
    ["Starts", formatDateTime(new Date(done.startsAt), timezone)],
    ["Ends", formatDateTime(new Date(done.endsAt), timezone)],
  ] as const;

  return (
    <div className="mx-auto w-full max-w-140 px-5 pt-6 pb-7">
      <div className="mb-3.5 text-center">
        <div className="mx-auto mb-2.5 flex size-10.5 items-center justify-center rounded-full bg-teal-100">
          <CheckIcon aria-hidden="true" className="size-5 text-success-fg" />
        </div>
        <h1
          id={BOOK_HEADING_ID}
          tabIndex={-1}
          className="text-xl font-semibold text-fg1"
        >
          Your reservation has been rescheduled.
        </h1>
      </div>

      <dl className="mb-2.5 flex flex-col gap-1.75 rounded-[0.875rem] border bg-card px-4.5 py-4 text-[0.8125rem] shadow-xs">
        {rows.map(([term, value]) => (
          <div key={term} className="flex flex-wrap justify-between gap-x-4">
            <dt className="text-fg3">{term}</dt>
            <dd className="min-w-0 text-right font-bold wrap-anywhere text-fg1">
              {value}
            </dd>
          </div>
        ))}
      </dl>

      <Link
        href="/reservations"
        className={cn(buttonVariants({ size: "lg" }), "mt-1 w-full")}
      >
        Done
      </Link>
    </div>
  );
}
