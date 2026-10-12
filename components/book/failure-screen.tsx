import Link from "next/link";
import { TriangleAlertIcon } from "lucide-react";
import { BOOK_HEADING_ID } from "./step-heading";

// The failure screen (spec 0010 AC-9). "nothing_booked": the saga rolled
// back. "unknown": the reply was lost, so the booking may have committed.
// Its Back and Try again sit in the flow, under the Turnstile widget.
export function FailureScreen({
  failure,
}: {
  readonly failure: "nothing_booked" | "unknown";
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
        {failure === "nothing_booked" ? (
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
