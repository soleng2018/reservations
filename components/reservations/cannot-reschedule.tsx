import Link from "next/link";
import { CalendarXIcon } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Spec 0011 AC-6: the learner's own booking that has ended, changed, or whose
// lab type has no bookable testbed left.
export function CannotReschedule() {
  return (
    <div className="mx-auto w-full max-w-110 px-5 pt-25 pb-20 text-center max-sm:pt-16">
      <div className="mx-auto mb-5.5 flex size-14 items-center justify-center rounded-xl bg-bg-inset">
        <CalendarXIcon aria-hidden="true" className="size-6.5 text-fg2" />
      </div>
      <h1 className="mb-6 text-title font-semibold text-fg1">
        This reservation can&apos;t be rescheduled any more.
      </h1>
      <Link
        href="/reservations"
        className={cn(buttonVariants({ variant: "outline", size: "lg" }))}
      >
        Back to your reservations
      </Link>
    </div>
  );
}
