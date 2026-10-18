import "server-only";
import { Link, Section, Text } from "react-email";
import { firstName } from "@/lib/manage-reservations";
import {
  WELCOME_SUBJECT,
  welcomeExpiry,
  type WelcomeEmailDetails,
} from "@/lib/welcome-email";
import { CtaButton } from "./cta-button";
import { BLUE, EmailFrame, MUTED, sectionPad } from "./email-frame";

// Spec 0014 AC-7: the set password email, in the booking emails' frame.

const PREVIEW = "Set a password to manage your Nile Hands-On Lab reservations.";

const small = {
  margin: 0,
  fontSize: "14px",
  lineHeight: 1.6,
  color: MUTED,
} as const;

export function WelcomeEmail({
  details,
  email,
  url,
}: {
  readonly details: WelcomeEmailDetails;
  // The learner's address as stored, even when rerouted to the dev inbox.
  readonly email: string;
  readonly url: string;
}) {
  return (
    <EmailFrame
      title={WELCOME_SUBJECT}
      preview={PREVIEW}
      heading="Set your password"
      intro={`Hi ${firstName(details.name)}, your Nile Hands-On Labs account for ${email} is ready. Set a password to view your lab access and reschedule or cancel reservations.`}
    >
      <CtaButton href={url}>Set my password</CtaButton>
      <Section style={sectionPad(8, 4)}>
        <Text style={small}>
          This link works once and expires {welcomeExpiry(details)}.
        </Text>
      </Section>
      <Section style={sectionPad(16, 4)}>
        <Text style={small}>
          Button not working? Paste this link into your browser:
        </Text>
        <Link
          href={url}
          style={{
            color: BLUE,
            fontSize: "13px",
            lineHeight: 1.6,
            wordBreak: "break-all",
          }}
        >
          {url}
        </Link>
      </Section>
      <Section style={sectionPad(16, 32)}>
        <Text style={small}>
          Didn&apos;t expect this? You can ignore this email.
        </Text>
      </Section>
    </EmailFrame>
  );
}
