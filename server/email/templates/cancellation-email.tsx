import "server-only";
import { Section } from "react-email";
import {
  emailEnd,
  emailStart,
  reserveUrl,
  type BookingEmailDetails,
} from "@/lib/booking-email";
import { CtaButton } from "./cta-button";
import { DetailsCard } from "./details-card";
import { EmailFrame, MUTED, sectionPad } from "./email-frame";

// Spec 0013 AC-13: the cancellation email, after
// context/Nile HOL Cancellation Email Standalone.html. The learner's only
// cancellation message: it carries the cancelled invite too.
export function CancellationEmail({
  details,
}: {
  readonly details: BookingEmailDetails;
}) {
  return (
    <EmailFrame
      title="Your reservation was cancelled"
      preview="Your reservation was cancelled."
      heading="Your reservation was cancelled"
      intro={`Hi ${details.learnerName}, your reservation has been cancelled and the testbed is released. The calendar event has been removed from your calendar and the lab access links no longer work.`}
    >
      <DetailsCard
        rows={[
          ["Lab type", details.labTypeName],
          ["Testbed", details.testbedName],
          ["Was scheduled", emailStart(details)],
          ["Until", emailEnd(details)],
        ]}
      />
      <Section
        style={{
          ...sectionPad(24, 4),
          fontSize: "15px",
          lineHeight: 1.6,
          color: MUTED,
        }}
      >
        You can book a new lab session at any time.
      </Section>
      <CtaButton href={reserveUrl(details)}>Reserve a new lab</CtaButton>
      <Section style={sectionPad(16, 32)} />
    </EmailFrame>
  );
}
