import type { Metadata } from "next";
import { connection } from "next/server";
import { BookingFlow } from "@/components/book/booking-flow";
import { LearnerFrame } from "@/components/learner-frame";
import { formatDuration } from "@/lib/duration";
import { bookableTypes } from "@/server/booking/availability";
import { db } from "@/server/db";
import { turnstileEnv } from "@/server/env";

// noindex through the root layout's default (spec 0009 AC-7).
export const metadata: Metadata = { title: "Book a lab" };

// The guest booking flow (spec 0010): the three steps, then progress and a
// success or failure screen. Public; no link to the admin URL anywhere in
// the flow (AC-13). The step lives in `?step=`, read by the client only.
export default async function BookPage() {
  await connection(); // the type list is live, never prerendered
  const types = await bookableTypes(db());

  return (
    <LearnerFrame>
      <BookingFlow
        types={types.map((t) => ({
          id: t.id,
          name: t.name,
          duration: formatDuration(t.durationValue, t.durationUnit),
        }))}
        siteKey={turnstileEnv().TURNSTILE_SITE_KEY}
      />
    </LearnerFrame>
  );
}
