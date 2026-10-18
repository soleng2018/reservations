import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LearnerFrame } from "@/components/learner-frame";
import { CannotReschedule } from "@/components/reservations/cannot-reschedule";
import { RescheduleFlow } from "@/components/reservations/reschedule-flow";
import { formatDuration } from "@/lib/duration";
import { requireLearner } from "@/server/auth/require";
import { ownReschedulable } from "@/server/booking/manage";
import { db } from "@/server/db";

// noindex through the root layout's default.
export const metadata: Metadata = { title: "Reschedule your reservation" };

// Spec 0011 AC-6: the learner's own live booking, moved through the /book
// step components. Another learner's id is indistinguishable from an
// unknown one. The step lives in `?step=`, read by the client only.
export default async function ReschedulePage(
  props: PageProps<"/reservations/[id]/reschedule">,
) {
  const { user } = await requireLearner();
  const { id } = await props.params;
  const found = await ownReschedulable(db(), user.id, id);
  if (found.kind === "missing") notFound();

  return (
    <LearnerFrame>
      {found.kind === "unavailable" ? (
        <CannotReschedule />
      ) : (
        <RescheduleFlow
          booking={{
            id: found.booking.id,
            version: found.booking.version,
            typeName: found.booking.typeName,
            durationLabel: formatDuration(
              found.booking.durationValue,
              found.booking.durationUnit,
            ),
            currentStart: found.booking.startsAt.toISOString(),
            current: found.booking.current,
            email: user.email,
            timezone: user.timezone,
          }}
        />
      )}
    </LearnerFrame>
  );
}
