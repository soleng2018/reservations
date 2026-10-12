import Link from "next/link";
import { CheckIcon } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import type { Booked } from "@/lib/booking-flow";
import { formatDateTime } from "@/lib/format-time";
import { cn } from "@/lib/utils";
import { BOOK_HEADING_ID } from "./step-heading";

// The success card (spec 0010 AC-10), from the bookAction state and the
// Step 1 name and email in memory, never from a URL. No lab links, Add to
// calendar, or View email yet (features 14 and 15).
export function BookingSuccess({
  booking,
  firstName,
  email,
}: {
  readonly booking: Booked;
  readonly firstName: string;
  readonly email: string;
}) {
  const rows = [
    ["Testbed", booking.testbedName],
    ["Lab type", booking.typeName],
    ["Starts", formatDateTime(new Date(booking.startsAt), booking.timezone)],
    ["Ends", formatDateTime(new Date(booking.endsAt), booking.timezone)],
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
          className="mb-1 text-xl font-semibold text-fg1"
        >
          You&apos;re all set{firstName ? `, ${firstName}` : ""}!
        </h1>
        <p className="text-sub text-fg2">
          Your reservation is confirmed for{" "}
          <span className="font-semibold wrap-anywhere text-fg1">{email}</span>.
        </p>
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

      {booking.newUser ? (
        <div className="mb-2.5 rounded-lg bg-nile-blue-050 px-4 py-3">
          <h2 className="mb-1 text-xs font-bold tracking-[0.04em] text-nile-blue uppercase">
            Set your password
          </h2>
          <p className="text-[0.8125rem] text-fg1">
            Check your inbox for a link to set your password. You&apos;ll use it
            with your email to manage this reservation later.
          </p>
        </div>
      ) : (
        <p className="mb-2.5 rounded-lg bg-bg-inset px-4 py-2.75 text-pill text-fg2">
          Sign in with your existing credentials anytime to manage this
          reservation.{" "}
          <Link
            href="/reservations"
            className="font-semibold text-primary underline underline-offset-4"
          >
            Manage my reservations
          </Link>
        </p>
      )}

      <Link
        href="/"
        className={cn(buttonVariants({ size: "lg" }), "mt-1 w-full")}
      >
        Done
      </Link>
    </div>
  );
}
