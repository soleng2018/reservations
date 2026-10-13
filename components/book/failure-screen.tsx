import Link from "next/link";
import { TriangleAlertIcon } from "lucide-react";
import { RESCHEDULE_MESSAGES } from "@/lib/booking-input";
import { BOOK_HEADING_ID } from "./step-heading";

// The failure screen (spec 0010 AC-9, spec 0011 AC-10). "nothing_booked":
// the saga or the reschedule rolled back. "unknown": the reply was lost, so
// the change may have committed. Its Back and Try again sit in the flow.
export function FailureScreen({
  failure,
  flow = "book",
}: {
  readonly failure: "nothing_booked" | "unknown";
  readonly flow?: "book" | "reschedule";
}) {
  return (
    <div className="text-center">
      <div className="mx-auto mb-5.5 flex size-14 items-center justify-center rounded-xl bg-crimson-100">
        <TriangleAlertIcon
          aria-hidden="true"
          className="size-6.5 text-danger-strong"
        />
      </div>
      <h1
        id={BOOK_HEADING_ID}
        tabIndex={-1}
        className="mb-2.5 text-title font-semibold text-fg1"
      >
        Something went wrong
      </h1>
      <p role="alert" className="text-cell leading-normal text-fg2">
        {flow === "reschedule" ? (
          failure === "nothing_booked" ? (
            RESCHEDULE_MESSAGES.unchanged
          ) : (
            <>
              We couldn&apos;t confirm the change. Check{" "}
              <Link
                href="/reservations"
                className="font-semibold text-primary underline underline-offset-4"
              >
                your reservations
              </Link>{" "}
              to see your current time.
            </>
          )
        ) : failure === "nothing_booked" ? (
          "We couldn't complete your reservation. Nothing was booked. Please try again."
        ) : (
          <>
            We couldn&apos;t confirm your reservation. If it went through,
            you&apos;ll find it under{" "}
            <Link
              href="/reservations"
              className="font-semibold text-primary underline underline-offset-4"
            >
              Manage an existing reservation
            </Link>
            .
          </>
        )}
      </p>
    </div>
  );
}
